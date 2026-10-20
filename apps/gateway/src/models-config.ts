import { readFileSync } from 'node:fs';
import { ConfigError, describeIssue } from '@ai-gateway/shared';
import { z } from 'zod';

const deploymentId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'use lowercase letters, digits, ".", "_" or "-"');

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
    provider: z.literal('mock'),
    model: z.string().min(1).default('mock'),
    mock: mockSettingsSchema.prefault({}),
    ...attemptTimeouts,
  })
  .strict();

const openAICompatibleDeployment = z
  .object({
    provider: z.literal('openai-compatible'),
    model: z.string().min(1),
    /** API root, e.g. https://api.openai.com/v1 */
    baseUrl: z.url({ protocol: /^https?$/ }),
    /** Name of the environment variable holding the API key; never the key itself. */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'use an environment variable name, e.g. OPENAI_API_KEY'),
    ...attemptTimeouts,
  })
  .strict();

const ollamaDeployment = z
  .object({
    provider: z.literal('ollama'),
    model: z.string().min(1),
    /** Server root; defaults to OLLAMA_BASE_URL. */
    baseUrl: z.url({ protocol: /^https?$/ }).optional(),
    ...attemptTimeouts,
  })
  .strict();

const deployment = z.discriminatedUnion('provider', [
  mockDeployment,
  ollamaDeployment,
  openAICompatibleDeployment,
]);

export const ROUTING_POLICIES = ['priority', 'weighted', 'lowest_latency', 'cost_aware'] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

const target = z
  .object({
    deployment: deploymentId,
    /** Share of traffic under the `weighted` policy. */
    weight: z.number().int().min(1).max(1_000).default(1),
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
  targets: { deployment: string; weight: number }[];
}

/** A model's routing, whichever form the file uses. */
export function modelRoute(m: z.input<typeof model> | ModelConfig): ModelRoute {
  if ('deployment' in m)
    return { policy: 'priority', targets: [{ deployment: m.deployment, weight: 1 }] };
  return {
    policy: m.policy ?? 'priority',
    targets: m.targets.map((t) => ({ deployment: t.deployment, weight: t.weight ?? 1 })),
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
