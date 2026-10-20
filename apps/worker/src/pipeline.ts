import type { Clock } from '@ai-gateway/shared';
import type { Redis } from '@ai-gateway/shared/node';

/**
 * The usage pipeline's state in Redis, measured when asked: the admin API's infra endpoint and
 * the worker's metrics both read it. Use a connection no blocking read holds.
 */
export interface PipelineState {
  /** Entries in the usage stream (processed ones are trimmed periodically). */
  streamLength: number;
  /** Entries no consumer has read yet: the worker's lag. Null when Redis does not report it. */
  unreadEvents: number | null;
  /** Entries read but not yet acknowledged (being processed, or left by a crashed consumer). */
  pendingEvents: number;
  /** Age of the oldest pending entry; null when none is pending. */
  oldestPendingAgeMs: number | null;
  consumers: number;
  /** Entries in the dead-letter stream. */
  deadLetterLength: number;
}

export interface PipelineNames {
  stream: string;
  dlqStream: string;
  group: string;
}

/** `[k1, v1, k2, v2]` (RESP2) as a lookup. */
function fields(reply: unknown): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(reply)) return map;
  for (let i = 0; i + 1 < reply.length; i += 2) map.set(String(reply[i]), reply[i + 1]);
  return map;
}

const NO_KEY = /no such key/i;

/** Throws when Redis is unreachable. */
export async function readPipelineState(
  redis: Redis,
  clock: Clock,
  names: PipelineNames,
): Promise<PipelineState> {
  const [streamLength, deadLetterLength] = await Promise.all([
    redis.xlen(names.stream),
    redis.xlen(names.dlqStream),
  ]);
  let groups: unknown[] = [];
  try {
    groups = (await redis.call('XINFO', 'GROUPS', names.stream)) as unknown[];
  } catch (err) {
    if (!(err instanceof Error && NO_KEY.test(err.message))) throw err;
  }
  const group = groups.map(fields).find((g) => g.get('name') === names.group);
  const pendingEvents = Number(group?.get('pending') ?? 0);
  const lag = group?.get('lag');
  let oldestPendingAgeMs: number | null = null;
  if (pendingEvents > 0) {
    const summary = (await redis.call('XPENDING', names.stream, names.group)) as unknown[];
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
}
