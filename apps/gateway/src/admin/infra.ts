import type { Clock } from '@ai-gateway/shared';
import type { Redis } from '@ai-gateway/shared/node';
import { readPipelineState } from '@ai-gateway/worker';
import { z } from 'zod';

/**
 * Operational state read on demand for the analytics API: the usage event pipeline in Redis,
 * circuit-breaker states and dependency round trips. Values are measured when asked, never stored
 * or estimated. History is kept by Prometheus (ADR 017), not here.
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
    pipeline: () => readPipelineState(redis, clock, options),
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
