import { z } from 'zod';

export type Env = Record<string, string | undefined>;

export const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);
export type LogLevel = z.infer<typeof logLevelSchema>;

const positiveIntMs = z.coerce.number().int().positive();

/** Settings every process (gateway, worker) reads; each app spreads this into its own schema. */
export const commonConfigShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: logLevelSchema.default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  SHUTDOWN_TIMEOUT_MS: positiveIntMs.default(10_000),
  /**
   * OpenTelemetry tracing (M17, ADR 037): the OTLP/HTTP collector's base URL (spans go to
   * `/v1/traces` under it, as the OTLP exporter specification defines). Unset: tracing is off and
   * the SDK is not loaded.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
};

/** Prometheus metrics settings (ADR 017) for both processes; each adds its own METRICS_PORT. */
export const metricsConfigShape = {
  /** Bearer token scrapes must send. The gateway serves /metrics on its main port only if set. */
  METRICS_TOKEN: z
    .string()
    .min(32, 'must be at least 32 characters')
    .regex(/^\S+$/, 'must not contain whitespace')
    .optional(),
  /** Bind address of the separate metrics listener; loopback keeps it off the network. */
  METRICS_HOST: z.string().min(1).default('127.0.0.1'),
};

/**
 * Which EventBus carries usage events (ADR 005, ADR 023): a Redis Stream (the default, and the
 * only option without AWS) or an SQS queue with a dead-letter queue. Read by the gateway, which
 * publishes, and by whatever consumes: the worker, or the gateway with RUN_WORKER_IN_PROCESS.
 */
export const eventBusConfigShape = {
  EVENT_BUS: z.enum(['redis', 'sqs']).default('redis'),
  /** The usage queue (EVENT_BUS=sqs). */
  SQS_QUEUE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Where the consumer moves events it could not process (EVENT_BUS=sqs). */
  SQS_DLQ_URL: z.url({ protocol: /^https?$/ }).optional(),
  /**
   * The queues' region (EVENT_BUS=sqs). Credentials come from the AWS SDK's default chain: the
   * instance role on EC2, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
   */
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'must be an AWS region such as us-east-1')
    .optional(),
  /** A non-AWS SQS endpoint, such as LocalStack's (`docker compose --profile aws-local`). */
  SQS_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
};

/** With EVENT_BUS=sqs, the queues and region are required. For a schema's superRefine. */
export function checkEventBusConfig(
  config: {
    EVENT_BUS: 'redis' | 'sqs';
    SQS_QUEUE_URL?: string | undefined;
    SQS_DLQ_URL?: string | undefined;
    AWS_REGION?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (config.EVENT_BUS !== 'sqs') return;
  for (const name of ['SQS_QUEUE_URL', 'SQS_DLQ_URL', 'AWS_REGION'] as const) {
    if (config[name] === undefined) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'is required when EVENT_BUS=sqs' });
    }
  }
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Validates environment variables against a schema. Empty strings count as unset so defaults
 * apply. Error messages name the variable and the rule, never the value, because values can be
 * secrets.
 */
export function parseConfig<S extends z.ZodType>(schema: S, env: Env): z.output<S> {
  const cleaned: Env = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }

  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const top = issue.path[0];
    if (typeof top === 'string' && cleaned[top] === undefined) {
      return `${issuePath(issue)}: is required`;
    }
    return describeIssue(issue);
  });
  throw new ConfigError(problems);
}

type Issue = z.ZodError['issues'][number];

function issuePath(issue: Issue): string {
  return issue.path.map(String).join('.') || '(root)';
}

/** One readable line per issue, `path: rule`. Zod messages name the rule, not the input value. */
export function describeIssue(issue: Issue): string {
  // An invalid record key says only "Invalid key in record"; the key's own rule explains why.
  const detail = issue.code === 'invalid_key' ? issue.issues[0]?.message : undefined;
  return `${issuePath(issue)}: ${detail === undefined ? issue.message : `${issue.message}: ${detail}`}`;
}
