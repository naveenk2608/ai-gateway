import { z } from 'zod';

/** `on` opts a request in where its project allows it; `off` keeps it out (ADR 040). */
export const SEMANTIC_HEADER = 'x-gateway-semantic-cache';
/** The similarity of the stored request a semantic hit was answered from, to four decimals. */
export const SIMILARITY_HEADER = 'x-gateway-semantic-similarity';

/**
 * `off`: no lookups. `header`: only requests that send `x-gateway-semantic-cache: on`. `all`:
 * every eligible request unless it sends `off`.
 */
export const SEMANTIC_MODES = ['off', 'header', 'all'] as const;

/**
 * The cosine similarity a hit needs when a project sets none: the lowest threshold measured at
 * which no near miss of the labelled set in `bench/semantic` is answered (vectors from
 * nomic-embed-text v1.5, M18 Part D). Lower ones answer requests that only look alike, such as
 * miles to kilometres for kilometres to miles. `pnpm bench:semantic` and
 * `bench/semantic/results.md` give the hit and false-hit rates at each threshold; ADR 040.
 */
export const DEFAULT_SEMANTIC_THRESHOLD = 0.995;

/**
 * A project's semantic cache settings (M18, ADR 040), stored in `projects.semantic_cache`. Off
 * until a project admin turns it on; an empty object is off. The bounds are this gateway's own
 * choices: a threshold under 0.5 would match unrelated text, the TTL runs from a minute to 30 days
 * (the exact cache's longest), and the row cap keeps a project's scan small.
 */
export const semanticPolicySchema = z
  .object({
    mode: z.enum(SEMANTIC_MODES).default('off'),
    /** Null: DEFAULT_SEMANTIC_THRESHOLD, so a re-measured default reaches such projects. */
    threshold: z.number().min(0.5).max(1).nullable().default(null),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 3600)
      .default(3_600),
    maxEntries: z.number().int().min(1).max(100_000).default(1_000),
  })
  .strict();

export type SemanticPolicy = z.output<typeof semanticPolicySchema>;

export const SEMANTIC_OFF: SemanticPolicy = semanticPolicySchema.parse({});

/** A stored policy; anything unreadable counts as off (the admin API only stores valid ones). */
export function parseSemanticPolicy(raw: unknown): SemanticPolicy {
  const parsed = semanticPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : SEMANTIC_OFF;
}

/** Whether this request asks for a semantic lookup under its project's mode and its header. */
export function semanticRequested(policy: SemanticPolicy, header: string | undefined): boolean {
  const choice = header?.trim().toLowerCase();
  if (policy.mode === 'off' || choice === 'off') return false;
  return policy.mode === 'all' || choice === 'on';
}
