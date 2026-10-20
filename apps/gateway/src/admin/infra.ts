import type { Clock } from '@ai-gateway/shared';
import type { Redis } from '@ai-gateway/shared/node';
import { z } from 'zod';

/**
 * Operational state read on demand for the analytics API: the usage event pipeline in Redis,
 * circuit-breaker states and dependency round trips. Values are measured when asked, never stored
 * or estimated; Prometheus metrics with history arrive in M8.
 */

export const pipelineSchema = z.object({
  /** Entries in the usage stream (processed ones are trimmed periodically). */
  streamLength: z.number(),
  /** Entries no consumer has read yet: the worker's lag. Null when Redis does not report it. */
  unreadEvents: z.number().nullable(),
  /** Entries read but not yet acknowledged (being processed, or left by a crashed consumer). */
  pendingEvents: z.number(),
  /** Age of the oldest pending entry; null when none is pending. */
  oldestPendingAgeMs: z.number().nullable(),
  consumers: z.number(),
  /** Entries in the dead-letter stream. */
  deadLetterLength: z.number(),
});
export type PipelineState = z.output<typeof pipelineSchema>;

export const breakerSchema = z.object({
  deployment: z.string(),
  /** Each gateway instance's last reported state; none means it never left `closed`. */
  instances: z.array(
    z.object({
      instanceId: z.string(),
      state: z.enum(['closed', 'open', 'half_open']),
      reason: z.string().nullable(),
      at: z.string().nullable(),
    }),
  ),
});
export type BreakerState = z.output<typeof breakerSchema>;

export interface InfraProbe {
  /** Throws when Redis is unreachable. */
  pipeline(): Promise<PipelineState>;
  /** Throws when Redis is unreachable. */
  breakers(): Promise<BreakerState[]>;
  /** Named round trips (postgres, redis); each rejects when its dependency is down. */
  checks: Record<string, () => Promise<void>>;
}

/** `[k1, v1, k2, v2]` (RESP2) as a lookup. */
function fields(reply: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(reply)) return map;
  for (let i = 0; i + 1 < reply.length; i += 2) map.set(String(reply[i]), reply[i + 1]);
  return map;
}

const NO_KEY = /no such key/i;

export function redisInfraProbe(options: {
  redis: Redis;
  clock: Clock;
  stream: string;
  dlqStream: string;
  group: string;
  deployments: readonly string[];
  /** Key prefix of the breaker hashes written by HealthReporter. */
  prefix?: string;
  checks: Record<string, () => Promise<void>>;
}): InfraProbe {
  const { redis, clock, prefix = 'gw:' } = options;
  return {
    checks: options.checks,
    async pipeline() {
      const [streamLength, deadLetterLength] = await Promise.all([
        redis.xlen(options.stream),
        redis.xlen(options.dlqStream),
      ]);
      let groups: unknown[] = [];
      try {
        groups = (await redis.call('XINFO', 'GROUPS', options.stream)) as unknown[];
      } catch (err) {
        if (!(err instanceof Error && NO_KEY.test(err.message))) throw err;
      }
      const group = groups.map(fields).find((g) => g.get('name') === options.group);
      const pendingEvents = Number(group?.get('pending') ?? 0);
      const lag = group?.get('lag');
      let oldestPendingAgeMs: number | null = null;
      if (pendingEvents > 0) {
        const summary = (await redis.call('XPENDING', options.stream, options.group)) as unknown[];
        const oldest = typeof summary[1] === 'string' ? Number(summary[1].split('-')[0]) : NaN;
        if (Number.isFinite(oldest)) oldestPendingAgeMs = Math.max(0, clock.now() - oldest);
      }
      return {
        streamLength,
        unreadEvents: group === undefined ? streamLength : lag == null ? null : Number(lag),
        pendingEvents,
        oldestPendingAgeMs,
        consumers: Number(group?.get('consumers') ?? 0),
        deadLetterLength,
      };
    },
    async breakers() {
      return Promise.all(
        options.deployments.map(async (deployment) => {
          const entries = await redis.hgetall(`${prefix}health:${deployment}`);
          const instances = Object.entries(entries).flatMap(([instanceId, raw]) => {
            try {
              const value = JSON.parse(raw) as { state?: unknown; reason?: unknown; at?: unknown };
              const state = z.enum(['closed', 'open', 'half_open']).safeParse(value.state);
              if (!state.success) return [];
              return [
                {
                  instanceId,
                  state: state.data,
                  reason: typeof value.reason === 'string' ? value.reason : null,
                  at: typeof value.at === 'string' ? value.at : null,
                },
              ];
            } catch {
              return [];
            }
          });
          instances.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
          return { deployment, instances };
        }),
      );
    },
  };
}
