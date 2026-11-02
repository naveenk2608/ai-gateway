import type { Clock, Env } from '@ai-gateway/shared';
import type { Logger } from '@ai-gateway/shared/node';
import {
  expandBaseUrl,
  modelRoute,
  type AdapterKind,
  type DeploymentConfig,
  type ModelsConfig,
  type RoutingPolicy,
} from '../models-config.js';
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
  /** The provider's model name, sent upstream. */
  providerModel: string;
  timeoutMs: number;
  streamIdleTimeoutMs: number;
  /** Output cap when the client sets none; the worst case limits and budgets reserve. */
  maxOutputTokens: number;
}

/** How a logical model is served: a policy over one or more available deployments. */
export interface Route {
  model: string;
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
      return { provider: new MockProvider(config.mock, deps.clock), baseUrl: null };
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
      probes: deployment.adapter === 'mock' || deployment.healthCheck === 'models',
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
    if (available.length > 0) models.set(name, { model: name, policy, targets: available });
    else
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
