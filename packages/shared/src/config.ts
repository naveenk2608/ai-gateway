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
};

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
