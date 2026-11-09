import type { Clock } from '@ai-gateway/shared';
import type { Redis } from '@ai-gateway/shared/node';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { MemoryGuard, parseMemoryInfo, type MemoryGuardSettings } from './memory-guard.js';
import { ResponseCache } from './response-cache.js';

const MiB = 1_048_576;

/** An `INFO memory` reply shaped like Redis's (CRLF lines, a section header, other fields). */
const info = (used: number, max: number) =>
  [
    '# Memory',
    `used_memory:${used}`,
    `used_memory_human:${(used / MiB).toFixed(2)}M`,
    'used_memory_rss:9999999',
    `maxmemory:${max}`,
    `maxmemory_human:${(max / MiB).toFixed(2)}M`,
    'maxmemory_policy:noeviction',
    '',
  ].join('\r\n');

function handClock() {
  let now = 1_000_000;
  const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
  return { clock, advance: (ms: number) => (now += ms) };
}

const SETTINGS: MemoryGuardSettings = {
  enabled: true,
  intervalMs: 5_000,
  maxShare: 0.5,
  maxBytesWhenUnlimited: 64 * MiB,
};

/** A guard whose INFO replies come from `replies` in turn (an Error is thrown). */
function guardWith(replies: (string | Error)[], settings = SETTINGS) {
  const t = handClock();
  const { logger, lines } = captureLogger();
  let calls = 0;
  const readings: [number, number][] = [];
  const guard = new MemoryGuard(settings, {
    info: () => {
      const reply = replies[Math.min(calls, replies.length - 1)]!;
      calls++;
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    clock: t.clock,
    logger,
    onReading: (r, cap) => readings.push([r.usedBytes, cap]),
  });
  return { guard, t, lines, readings, calls: () => calls };
}

describe('parseMemoryInfo', () => {
  it('reads used_memory and maxmemory from an INFO memory reply', () => {
    expect(parseMemoryInfo(info(3 * MiB, 25 * MiB))).toEqual({
      usedBytes: 3 * MiB,
      maxBytes: 25 * MiB,
    });
    expect(parseMemoryInfo('used_memory:10\nmaxmemory:0\n')).toEqual({
      usedBytes: 10,
      maxBytes: 0,
    });
  });

  it('returns null when a field is missing or not a number', () => {
    expect(parseMemoryInfo('# Memory\r\nused_memory:10\r\n')).toBeNull();
    expect(parseMemoryInfo('used_memory:x\r\nmaxmemory:10\r\n')).toBeNull();
    expect(parseMemoryInfo('')).toBeNull();
  });
});

describe('MemoryGuard', () => {
  it('allows stores below the share of maxmemory and refuses them at or above it', async () => {
    const below = guardWith([info(12 * MiB, 25 * MiB)]);
    expect(await below.guard.check()).toEqual({ ok: true });
    expect(below.readings).toEqual([[12 * MiB, Math.floor(12.5 * MiB)]]);
    const at = guardWith([info(Math.floor(12.5 * MiB), 25 * MiB)]);
    expect(await at.guard.check()).toEqual({ ok: false, reason: 'memory_cap' });
  });

  it('uses the absolute cap when maxmemory is 0', async () => {
    const under = guardWith([info(63 * MiB, 0)]);
    expect(await under.guard.check()).toEqual({ ok: true });
    const over = guardWith([info(64 * MiB, 0)]);
    expect(await over.guard.check()).toEqual({ ok: false, reason: 'memory_cap' });
    expect(over.readings).toEqual([[64 * MiB, 64 * MiB]]);
  });

  it('asks INFO at most once per interval, and concurrent checks share one call', async () => {
    const g = guardWith([info(1 * MiB, 25 * MiB), info(20 * MiB, 25 * MiB)]);
    await Promise.all([g.guard.check(), g.guard.check(), g.guard.check()]);
    expect(g.calls()).toBe(1);
    g.t.advance(4_999);
    expect(await g.guard.check()).toEqual({ ok: true });
    expect(g.calls()).toBe(1);
    g.t.advance(1);
    expect(await g.guard.check()).toEqual({ ok: false, reason: 'memory_cap' });
    expect(g.calls()).toBe(2);
  });

  it('stores nothing while INFO fails, logs it once, and resumes when a reading works', async () => {
    const denied = new Error("NOPERM User default has no permissions to run the 'info' command");
    const g = guardWith([denied, denied, 'no fields here', info(1 * MiB, 25 * MiB)]);
    expect(await g.guard.check()).toEqual({ ok: false, reason: 'memory_unknown' });
    g.t.advance(5_000);
    expect(await g.guard.check()).toEqual({ ok: false, reason: 'memory_unknown' });
    g.t.advance(5_000);
    expect(await g.guard.check()).toEqual({ ok: false, reason: 'memory_unknown' });
    const paused = g.lines.filter((l) => l.msg?.includes('stores paused'));
    expect(paused).toHaveLength(1);
    g.t.advance(5_000);
    expect(await g.guard.check()).toEqual({ ok: true });
    expect(g.lines.some((l) => l.msg?.includes('stores resumed'))).toBe(true);
  });

  it('allows every store without asking INFO when switched off', async () => {
    const g = guardWith([new Error('never asked')], { ...SETTINGS, enabled: false });
    expect(await g.guard.check()).toEqual({ ok: true });
    expect(g.calls()).toBe(0);
  });
});

describe('ResponseCache with a memory guard', () => {
  const answer = {
    content: 'hello',
    finishReason: 'stop' as const,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  /** A Redis stand-in that keeps values in a map; `failSet` makes writes reject. */
  function fakeRedis(failSet = false) {
    const values = new Map<string, string>();
    const redis = {
      get: (key: string) => Promise.resolve(values.get(key) ?? null),
      set: (key: string, value: string) => {
        if (failSet) return Promise.reject(new Error('OOM command not allowed'));
        values.set(key, value);
        return Promise.resolve('OK');
      },
    } as unknown as Redis;
    return { redis, values };
  }

  function cacheWith(reply: string | Error, failSet = false, maxEntryBytes = 10_000) {
    const { redis, values } = fakeRedis(failSet);
    const g = guardWith([reply]);
    const skips: string[] = [];
    const { logger, lines } = captureLogger();
    const cache = new ResponseCache({
      redis,
      logger,
      ttlSeconds: 60,
      maxEntryBytes,
      guard: g.guard,
      onSkip: (reason) => skips.push(reason),
    });
    return { cache, values, skips, lines };
  }

  it('stores below the cap', async () => {
    const c = cacheWith(info(1 * MiB, 25 * MiB));
    c.cache.set('k', answer);
    await flush();
    expect(await c.cache.get('k')).toEqual(answer);
    expect(c.skips).toEqual([]);
  });

  it('skips stores above the cap and while memory is unknown, and lookups keep working', async () => {
    const over = cacheWith(info(20 * MiB, 25 * MiB));
    over.values.set('gw:cache:old', JSON.stringify(answer));
    over.cache.set('k', answer);
    over.cache.setEmbeddings('e', { data: [[0.1]], usage: null });
    await flush();
    expect([...over.values.keys()]).toEqual(['gw:cache:old']);
    expect(over.skips).toEqual(['memory_cap', 'memory_cap']);
    expect(await over.cache.get('old')).toEqual(answer);

    const unknown = cacheWith(new Error('NOPERM'));
    unknown.cache.set('k', answer);
    await flush();
    expect(unknown.values.size).toBe(0);
    expect(unknown.skips).toEqual(['memory_unknown']);
  });

  it('never throws when a store fails or is too large', async () => {
    const failing = cacheWith(info(1 * MiB, 25 * MiB), true);
    expect(() => failing.cache.set('k', answer)).not.toThrow();
    await flush();
    expect(failing.lines.some((l) => l.msg === 'response cache write failed')).toBe(true);

    const small = cacheWith(info(1 * MiB, 25 * MiB), false, 10);
    small.cache.set('k', answer);
    await flush();
    expect(small.values.size).toBe(0);
    expect(small.skips).toEqual(['too_large']);
  });
});
