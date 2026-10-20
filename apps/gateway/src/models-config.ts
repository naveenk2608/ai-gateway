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

const mockSettings = z
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
    mock: mockSettings.prefault({}),
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

export const modelsConfigSchema = z
  .object({
    deployments: z.record(deploymentId, deployment),
    /** Logical model names that clients send, each served by one deployment. */
    models: z.record(z.string().min(1).max(256), z.object({ deployment: deploymentId }).strict()),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [name, model] of Object.entries(config.models)) {
      if (!Object.hasOwn(config.deployments, model.deployment)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', name, 'deployment'],
          message: `unknown deployment "${model.deployment}"`,
        });
      }
    }
  });

export type ModelsConfig = z.output<typeof modelsConfigSchema>;
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
