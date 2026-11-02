import { readFileSync } from 'node:fs';
import { ConfigError, describeIssue } from '@ai-gateway/shared';
import { z } from 'zod';

const deploymentId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'use lowercase letters, digits, ".", "_" or "-"');

/** Adapter kinds: the wire protocol a deployment is called with. */
export const ADAPTERS = ['mock', 'ollama', 'openai-compatible'] as const;
export type AdapterKind = (typeof ADAPTERS)[number];

/**
 * Who serves the deployment (groq, gemini, mistral, ...). Prices are keyed by it and the
 * provider's own model name, so two OpenAI-compatible providers serving the same model name keep
 * separate prices. Defaults to the adapter kind.
 */
const providerName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, 'use lowercase letters, digits, ".", "_" or "-"');

/** `${NAME}` in a base URL: replaced at startup with the environment variable's value. */
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** An http(s) URL, which may contain `${NAME}` placeholders (never the values themselves). */
const baseUrl = z.string().refine((value) => {
  try {
    const url = new URL(value.replace(PLACEHOLDER, 'placeholder'));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'use an http(s) URL; ${NAME} placeholders are filled from the environment');

/** Names of the environment variables a base URL's placeholders read. */
export function baseUrlVariables(url: string): string[] {
  return [...url.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/**
 * The base URL with each placeholder replaced by its (URL-encoded) environment value, or the
 * name of the first variable that is unset.
 */
export function expandBaseUrl(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
): { url: string } | { missing: string } {
  for (const name of baseUrlVariables(url)) {
    if (!env[name]) return { missing: name };
  }
  return { url: url.replace(PLACEHOLDER, (_, name: string) => encodeURIComponent(env[name]!)) };
}

/**
 * How an open breaker's deployment is health-checked (ADR 012): `models` lists models (runs no
 * model), `none` sends nothing, for providers without a model list; the breaker then half-opens
 * after BREAKER_OPEN_MS.
 */
const healthCheck = z.enum(['models', 'none']).default('models');

export const BILLING = ['free_tier', 'paid'] as const;
export type Billing = (typeof BILLING)[number];

/**
 * Whether the provider charges for this deployment (ADR 024). `free_tier`: requests are billed
 * nothing, while their list cost is still recorded and counted by budgets. Defaults to `paid`, so
 * nothing is under-counted.
 */
const billing = z.enum(BILLING).default('paid');

const attemptTimeouts = {
  /** Non-streaming: the whole attempt. Streaming: until the first event. */
  timeoutMs: z.number().int().positive().max(600_000).default(60_000),
  /** Streaming: the longest allowed gap between events after the first. */
  streamIdleTimeoutMs: z.number().int().positive().max(600_000).default(30_000),
  /**
   * Output cap sent upstream when the client sets no max_tokens. It is the worst case that limits
   * and budgets reserve (ADR 008, ADR 009), so it must be a real bound.
   */
  maxOutputTokens: z.number().int().positive().max(1_000_000).default(4_096),
};

/** The mock's timing and failure settings: a deployment's `mock` block, or `MOCK_SETTINGS`. */
export const mockSettingsSchema = z
  .object({
    latencyMs: z.number().int().min(0).default(0),
    ttftMs: z.number().int().min(0).default(0),
    tokensPerSecond: z.number().positive().optional(),
    completionTokens: z.number().int().min(0).max(100_000).default(16),
    promptTokens: z.number().int().min(0).optional(),
    errorRate: z.number().min(0).max(1).default(0),
    seed: z.number().int().default(1),
    failWith: z.union([z.literal(429), z.literal(500)]).optional(),
    retryAfterMs: z.number().int().min(0).default(1_000),
    dropAfterTokens: z.number().int().min(0).optional(),
  })
  .strict();

const mockDeployment = z
  .object({
    adapter: z.literal('mock'),
    provider: providerName.default('mock'),
    model: z.string().min(1).default('mock'),
    mock: mockSettingsSchema.prefault({}),
    billing,
    ...attemptTimeouts,
  })
  .strict();

const openAICompatibleDeployment = z
  .object({
    adapter: z.literal('openai-compatible'),
    provider: providerName.default('openai-compatible'),
    model: z.string().min(1),
    /** API root, e.g. https://api.groq.com/openai/v1; may hold `${NAME}` placeholders. */
    baseUrl,
    /** Name of the environment variable holding the API key; never the key itself. */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'use an environment variable name, e.g. GROQ_API_KEY'),
    healthCheck,
    billing,
    ...attemptTimeouts,
  })
  .strict();

const ollamaDeployment = z
  .object({
    adapter: z.literal('ollama'),
    provider: providerName.default('ollama'),
    model: z.string().min(1),
    /** Server root; defaults to OLLAMA_BASE_URL. */
    baseUrl: z.url({ protocol: /^https?$/ }).optional(),
    healthCheck,
    billing,
    ...attemptTimeouts,
  })
  .strict();

/**
 * Files written before provider names existed set `provider` to the adapter kind and have no
 * `adapter`: they are read as that adapter, with the provider name defaulting to it.
 */
function legacyAdapter(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || 'adapter' in raw) {
    return raw;
  }
  const { provider, ...rest } = raw as Record<string, unknown>;
  if (typeof provider !== 'string' || !(ADAPTERS as readonly string[]).includes(provider)) {
    return raw;
  }
  return { adapter: provider, ...rest };
}

const deployment = z.preprocess(
  legacyAdapter,
  z.discriminatedUnion('adapter', [mockDeployment, ollamaDeployment, openAICompatibleDeployment]),
);

export const ROUTING_POLICIES = ['priority', 'weighted', 'lowest_latency', 'cost_aware'] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

const target = z
  .object({
    deployment: deploymentId,
    /** Share of traffic under the `weighted` policy. */
    weight: z.number().int().min(1).max(1_000).default(1),
    /**
     * Tried only after every other target, in the order listed, whatever the policy: a fallback
     * (such as the mock) that should never win on latency, price or weight.
     */
    lastResort: z.boolean().default(false),
  })
  .strict();

/**
 * A logical model: one deployment, or several targets tried in the order the policy picks, with
 * fallback to the next when one fails (ADR 011). `modelRoute` reads both forms the same way.
 */
const model = z.union([
  z.object({ deployment: deploymentId }).strict(),
  z
    .object({
      policy: z.enum(ROUTING_POLICIES).default('priority'),
      targets: z.array(target).min(1).max(10),
    })
    .strict(),
]);

export const modelsConfigSchema = z
  .object({
    deployments: z.record(deploymentId, deployment),
    /** Logical model names that clients send, each routed to one or more deployments. */
    models: z.record(z.string().min(1).max(256), model),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [name, m] of Object.entries(config.models)) {
      const seen = new Set<string>();
      modelRoute(m).targets.forEach((t, i) => {
        const path =
          'deployment' in m
            ? ['models', name, 'deployment']
            : ['models', name, 'targets', i, 'deployment'];
        if (!Object.hasOwn(config.deployments, t.deployment)) {
          ctx.addIssue({ code: 'custom', path, message: `unknown deployment "${t.deployment}"` });
        }
        if (seen.has(t.deployment)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `deployment "${t.deployment}" is listed twice`,
          });
        }
        seen.add(t.deployment);
      });
    }
  });

export type ModelsConfig = z.output<typeof modelsConfigSchema>;
export type ModelConfig = ModelsConfig['models'][string];

export interface ModelRoute {
  policy: RoutingPolicy;
  targets: { deployment: string; weight: number; lastResort: boolean }[];
}

/** A model's routing, whichever form the file uses. */
export function modelRoute(m: z.input<typeof model> | ModelConfig): ModelRoute {
  if ('deployment' in m)
    return {
      policy: 'priority',
      targets: [{ deployment: m.deployment, weight: 1, lastResort: false }],
    };
  return {
    policy: m.policy ?? 'priority',
    targets: m.targets.map((t) => ({
      deployment: t.deployment,
      weight: t.weight ?? 1,
      lastResort: t.lastResort ?? false,
    })),
  };
}
export type DeploymentConfig = ModelsConfig['deployments'][string];

export function parseModelsConfig(raw: unknown, source: string): ModelsConfig {
  const result = modelsConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new ConfigError(result.error.issues.map((issue) => `${source}: ${describeIssue(issue)}`));
}

/** Reads and validates the models file once at startup. */
export function readModelsConfig(path: string): ModelsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError([`${path}: cannot read models config: ${reason}`]);
  }
  return parseModelsConfig(raw, path);
}
