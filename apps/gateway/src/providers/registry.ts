import type { Clock, Env } from '@ai-gateway/shared';
import type { Logger } from '@ai-gateway/shared/node';
import {
  expandBaseUrl,
  modelRoute,
  type AdapterKind,
  type Billing,
  type Capabilities,
  type DeploymentType,
  type DeploymentConfig,
  type HealthCheckKind,
  type ModelsConfig,
  type RoutingPolicy,
} from '../models-config.js';
import type { QuotaGroupShare, QuotaLimits } from '../routing/quota.js';
import { dialectFor, type Dialect } from './dialects.js';
import { MockProvider } from './mock.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { Provider } from './types.js';

/** One configured upstream: a provider instance plus the model and timeouts to use with it. */
export interface Deployment {
  id: string;
  provider: Provider;
  /** Who serves it (groq, gemini, mock, ...): the key for its prices and metrics. */
  providerName: string;
  adapter: AdapterKind;
  /** Host of the base URL, for display; null for the in-process mock. */
  baseUrlHost: string | null;
  /** False when the deployment is never probed (`healthCheck: "none"`). */
  probes: boolean;
  /**
   * How an open breaker's deployment is probed: `models` lists models (no model runs), `chat`
   * asks for one token (ADR 026), `none` sends nothing. The mock is probed in process.
   */
  healthCheck: HealthCheckKind;
  /** `free_tier`: the provider charges nothing; the list cost is still recorded (ADR 024). */
  billing: Billing;
  /** What its model can do: tools, JSON output, image input (ADR 028). */
  capabilities: Capabilities;
  /** `chat` or `embeddings` (ADR 029). */
  type: DeploymentType;
  /** Vector size, the sizes a client may ask for, and inputs per request; null for chat. */
  embedding: EmbeddingSpec | null;
  /** What its provider's API takes of the gateway's fields (dialects.ts). */
  dialect: Dialect;
  /** Free-tier limits counted in Redis across instances (ADR 025); null without any. */
  quota: QuotaLimits | null;
  /** The free allowance it shares with other deployments of its account (ADR 025); null if none. */
  quotaGroup: QuotaGroupShare | null;
  /** The provider's model name, sent upstream. */
  providerModel: string;
  timeoutMs: number;
  streamIdleTimeoutMs: number;
  /** Output cap when the client sets none; the worst case limits and budgets reserve. */
  maxOutputTokens: number;
}

export interface EmbeddingSpec {
  dimensions: number;
  dimensionsRange: { min: number; max: number } | null;
  maxInputs: number | null;
}

/** How a logical model is served: a policy over one or more available deployments. */
export interface Route {
  model: string;
  /** What its deployments serve; config validation keeps a route to one type. */
  type: DeploymentType;
  policy: RoutingPolicy;
  targets: { deployment: Deployment; weight: number; lastResort: boolean }[];
}

export interface RegistryDeps {
  clock: Clock;
  logger: Logger;
  /** Where API keys named by `apiKeyEnv` are looked up. */
  env: Env;
  /** Used by Ollama deployments that do not set their own baseUrl. */
  ollamaBaseUrl: string;
}

export class ProviderRegistry {
  readonly #deployments: Map<string, Deployment>;
  readonly #models: Map<string, Route>;

  constructor(deployments: Map<string, Deployment>, models: Map<string, Route>) {
    this.#deployments = deployments;
    this.#models = models;
  }

  /** How a logical model is routed, if it is configured and has an available deployment. */
  route(model: string): Route | undefined {
    return this.#models.get(model);
  }

  deployment(id: string): Deployment | undefined {
    return this.#deployments.get(id);
  }

  deployments(): Deployment[] {
    return [...this.#deployments.values()];
  }

  modelNames(): string[] {
    return [...this.#models.keys()];
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#deployments.values()].map((d) => d.provider.close()));
  }
}

type Created = { provider: Provider; baseUrl: string | null } | { disabled: string };

function createProvider(config: DeploymentConfig, deps: RegistryDeps): Created {
  switch (config.adapter) {
    case 'mock':
      return {
        provider: new MockProvider(
          { ...config.mock, embeddingDimensions: config.embedding?.dimensions },
          deps.clock,
        ),
        baseUrl: null,
      };
    case 'ollama': {
      const baseUrl = config.baseUrl ?? deps.ollamaBaseUrl;
      return { provider: new OllamaProvider({ baseUrl, clock: deps.clock }), baseUrl };
    }
    case 'openai-compatible': {
      const apiKey = deps.env[config.apiKeyEnv];
      if (!apiKey) return { disabled: `${config.apiKeyEnv} is not set` };
      const expanded = expandBaseUrl(config.baseUrl, deps.env);
      if ('missing' in expanded) return { disabled: `${expanded.missing} is not set` };
      return {
        provider: new OpenAICompatibleProvider({
          baseUrl: expanded.url,
          apiKey,
          clock: deps.clock,
          dialect: dialectFor(config.adapter, config.provider),
        }),
        baseUrl: expanded.url,
      };
    }
  }
}

/** The host of a base URL, never its path (which may hold an account ID). */
export function urlHost(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Builds providers for every deployment and maps each logical model to its deployment. */
/** A deployment's share of a quota group, resolved from the models file's `quotaGroups`. */
function groupShare(
  config: ModelsConfig,
  share: ModelsConfig['deployments'][string]['quotaGroup'],
): QuotaGroupShare | null {
  if (!share) return null;
  const group = config.quotaGroups[share.group];
  if (!group) return null;
  return {
    id: share.group,
    unit: group.unit,
    perMinute: group.perMinute,
    perDay: group.perDay,
    perRequest: share.perRequest ?? 0,
    perMillionInputTokens: share.perMillionInputTokens ?? 0,
    perMillionOutputTokens: share.perMillionOutputTokens ?? 0,
  };
}

export function createRegistry(config: ModelsConfig, deps: RegistryDeps): ProviderRegistry {
  const deployments = new Map<string, Deployment>();
  for (const [id, deployment] of Object.entries(config.deployments)) {
    const created = createProvider(deployment, deps);
    if ('disabled' in created) {
      deps.logger.warn({ deployment: id, reason: created.disabled }, 'deployment disabled');
      continue;
    }
    deployments.set(id, {
      id,
      provider: created.provider,
      providerName: deployment.provider,
      adapter: deployment.adapter,
      baseUrlHost: urlHost(created.baseUrl),
      probes: deployment.adapter === 'mock' || deployment.healthCheck !== 'none',
      healthCheck: deployment.adapter === 'mock' ? 'models' : deployment.healthCheck,
      billing: deployment.billing,
      capabilities: deployment.capabilities,
      dialect: dialectFor(deployment.adapter, deployment.provider),
      type: deployment.type,
      embedding: deployment.embedding
        ? {
            dimensions: deployment.embedding.dimensions,
            dimensionsRange: deployment.embedding.dimensionsRange ?? null,
            maxInputs: deployment.embedding.maxInputs ?? null,
          }
        : null,
      quota: deployment.quota ?? null,
      quotaGroup: groupShare(config, deployment.quotaGroup),
      providerModel: deployment.model,
      timeoutMs: deployment.timeoutMs,
      streamIdleTimeoutMs: deployment.streamIdleTimeoutMs,
      maxOutputTokens: deployment.maxOutputTokens,
    });
  }

  const models = new Map<string, Route>();
  for (const [name, model] of Object.entries(config.models)) {
    const { policy, targets } = modelRoute(model);
    const available = targets.flatMap((t) => {
      const deployment = deployments.get(t.deployment);
      return deployment ? [{ deployment, weight: t.weight, lastResort: t.lastResort }] : [];
    });
    if (available.length > 0) {
      models.set(name, {
        model: name,
        type: available[0]!.deployment.type,
        policy,
        targets: available,
      });
    } else
      deps.logger.warn(
        { model: name, reason: 'none of its deployments is enabled' },
        'model unavailable',
      );
  }

  deps.logger.info(
    { models: [...models.keys()], deployments: [...deployments.keys()] },
    'model registry loaded',
  );
  return new ProviderRegistry(deployments, models);
}
