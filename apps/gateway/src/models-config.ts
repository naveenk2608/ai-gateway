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
 * after BREAKER_OPEN_MS. `chat` sends one request for a single token, at most once per
 * HEALTH_CHECK_CHAT_INTERVAL_MS, for providers whose model list can include models they will not
 * serve (ADR 026); it counts against the deployment's quota.
 */
export const HEALTH_CHECKS = ['models', 'chat', 'none'] as const;
export type HealthCheckKind = (typeof HEALTH_CHECKS)[number];
const healthCheck = z.enum(HEALTH_CHECKS).default('models');

export const BILLING = ['free_tier', 'paid'] as const;
export type Billing = (typeof BILLING)[number];

/**
 * Whether the provider charges for this deployment (ADR 024). `free_tier`: requests are billed
 * nothing, while their list cost is still recorded and counted by budgets. Defaults to `paid`, so
 * nothing is under-counted.
 */
const billing = z.enum(BILLING).default('paid');

/** What a deployment's model can do with a request (ADR 028). */
export const CAPABILITIES = ['tools', 'json_object', 'json_schema', 'vision'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Capabilities = Record<Capability, boolean>;

const capabilityFlags = (byDefault: boolean) =>
  z
    .object({
      tools: z.boolean().default(byDefault),
      json_object: z.boolean().default(byDefault),
      json_schema: z.boolean().default(byDefault),
      vision: z.boolean().default(byDefault),
    })
    .strict()
    .prefault({});

/**
 * What the deployment's model can do, from the provider's docs for that exact model: tools,
 * JSON mode (`json_object`), schema-constrained JSON (`json_schema`) and image input (`vision`).
 * Unknown is false, so a request that uses one is never sent where the docs do not promise it
 * (ADR 028). Every value has its source in docs/providers.md.
 */
const capabilities = capabilityFlags(false);

/** What a deployment serves: chat completions, or embeddings (M13, ADR 029). */
export const DEPLOYMENT_TYPES = ['chat', 'embeddings'] as const;
export type DeploymentType = (typeof DEPLOYMENT_TYPES)[number];

/** Inputs per embeddings request at most: OpenAI's documented limit for the format it copies. */
export const MAX_EMBEDDING_INPUTS = 2_048;

/**
 * An embeddings deployment's vectors, from the provider's docs: their size when the client sets
 * no `dimensions`, the sizes a client may ask for instead (none: `dimensions` gets a 400), and
 * the inputs per request the provider takes, where it documents a limit.
 */
const embedding = z
  .object({
    dimensions: z.number().int().positive().max(65_536),
    dimensionsRange: z
      .object({
        min: z.number().int().positive().max(65_536),
        max: z.number().int().positive().max(65_536),
      })
      .strict()
      .optional(),
    maxInputs: z.number().int().positive().max(MAX_EMBEDDING_INPUTS).optional(),
  })
  .strict()
  .optional();

const kind = {
  type: z.enum(DEPLOYMENT_TYPES).default('chat'),
  /** Required for `type: "embeddings"`, refused otherwise. */
  embedding,
};

const perWindow = z.number().int().positive().max(1_000_000_000).optional();

/**
 * A provider's published free-tier limits for this deployment (ADR 025), counted across every
 * gateway instance in fixed UTC minutes and days. A deployment whose quota would be exceeded is
 * skipped. Only values from the provider's own docs belong here (see docs/providers.md).
 */
const quota = z
  .object({
    requestsPerMinute: perWindow,
    requestsPerDay: perWindow,
    tokensPerMinute: perWindow,
    tokensPerDay: perWindow,
  })
  .strict()
  .refine((q) => Object.values(q).some((v) => v !== undefined), 'set at least one limit')
  .optional();

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
    // The mock fakes every capability (tool calls, JSON), so tests can use any route shape.
    capabilities: capabilityFlags(true),
    ...kind,
    billing,
    quota,
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
    capabilities,
    ...kind,
    billing,
    quota,
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
    capabilities,
    ...kind,
    billing,
    quota,
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
    for (const [id, d] of Object.entries(config.deployments)) {
      const issue = (message: string, field: string) =>
        ctx.addIssue({ code: 'custom', path: ['deployments', id, field], message });
      if (d.type === 'embeddings') {
        if (!d.embedding) issue('an embeddings deployment needs embedding.dimensions', 'embedding');
        const range = d.embedding?.dimensionsRange;
        if (
          range &&
          !(range.min <= d.embedding!.dimensions && d.embedding!.dimensions <= range.max)
        ) {
          issue('embedding.dimensionsRange must include embedding.dimensions', 'embedding');
        }
        if (d.adapter !== 'mock' && d.healthCheck === 'chat') {
          issue('an embeddings deployment cannot have a chat health check', 'healthCheck');
        }
      } else if (d.embedding) {
        issue('embedding is only for "type": "embeddings"', 'embedding');
      }
    }
    for (const [name, m] of Object.entries(config.models)) {
      embeddingRouteIssues(config.deployments, modelRoute(m)).forEach((message) =>
        ctx.addIssue({ code: 'custom', path: ['models', name], message }),
      );
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

type DeploymentOutput = z.output<typeof deployment>;

/**
 * Why a model's targets cannot form one route (ADR 029): chat and embedding deployments never mix,
 * and an embeddings model falls back only between deployments of the same model with the same
 * vector size, never to the mock, since vectors from different models cannot share an index.
 */
function embeddingRouteIssues(
  deployments: Record<string, DeploymentOutput>,
  route: ModelRoute,
): string[] {
  const listed = route.targets.flatMap((t) => {
    const d = deployments[t.deployment];
    return d ? [[t.deployment, d] as const] : [];
  });
  const [first] = listed;
  if (!first) return [];
  const [firstId, head] = first;
  const issues: string[] = [];
  for (const [id, d] of listed.slice(1)) {
    if (d.type !== head.type) {
      issues.push(
        head.type === 'chat'
          ? `a chat model cannot list the embeddings deployment "${id}"`
          : `an embeddings model cannot list the chat deployment "${id}"`,
      );
      continue;
    }
    if (head.type !== 'embeddings') continue;
    if ((d.adapter === 'mock') !== (head.adapter === 'mock')) {
      issues.push(
        `an embeddings model never falls back to or from the mock ("${firstId}", "${id}")`,
      );
    } else if (d.model !== head.model) {
      issues.push(
        `an embeddings model falls back only between deployments of one model: "${firstId}" ` +
          `serves ${head.model}, "${id}" serves ${d.model}`,
      );
    } else if (
      d.embedding?.dimensions !== head.embedding?.dimensions ||
      JSON.stringify(d.embedding?.dimensionsRange) !==
        JSON.stringify(head.embedding?.dimensionsRange)
    ) {
      issues.push(
        `an embeddings model falls back only between deployments with the same dimensions ` +
          `("${firstId}", "${id}")`,
      );
    }
  }
  return issues;
}

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
