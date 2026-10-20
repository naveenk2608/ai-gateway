import { ManualClock, uuidv7, type UsageEvent } from '@ai-gateway/shared';
import type { Redis } from '@ai-gateway/shared/node';
import { describe, expect, it, vi } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { RedisStreamBus } from './redis-stream.js';

function event(): UsageEvent {
  const now = new Date().toISOString();
  return {
    v: 1,
    type: 'request.completed',
    eventId: uuidv7(),
    occurredAt: now,
    request: {
      id: uuidv7(),
      projectId: uuidv7(),
      apiKeyId: null,
      model: 'm',
      deployment: null,
      stream: false,
      status: 'rejected',
      httpStatus: 404,
      errorCode: 'model_not_found',
      startedAt: now,
      completedAt: now,
      latencyMs: 0,
      ttftMs: null,
    },
    attempts: [],
    usage: null,
    usageSource: 'missing',
  };
}

/** A Redis stand-in whose pipelines fail while `down` is true. */
function fakeRedis() {
  const state = { down: false, stored: [] as string[], execs: 0 };
  const redis = {
    pipeline() {
      const queued: string[] = [];
      return {
        xadd: (...args: (string | number)[]) => {
          queued.push(String(args.at(-1)));
        },
        exec: () => {
          state.execs++;
          if (state.down) return Promise.reject(new Error('connection refused'));
          state.stored.push(...queued);
          return Promise.resolve(queued.map(() => [null, 'id']));
        },
      };
    },
  };
  return { redis: redis as unknown as Redis, state };
}

describe('RedisStreamBus', () => {
  it('writes events in order without blocking the caller', async () => {
    const { redis, state } = fakeRedis();
    const bus = new RedisStreamBus({
      redis,
      logger: captureLogger().logger,
      clock: new ManualClock(),
      bufferMax: 100,
      streamMaxLen: 1_000,
    });
    const events = [event(), event(), event()];
    for (const e of events) bus.publish(e);
    await vi.waitFor(() => expect(state.stored).toHaveLength(3));
    expect(state.stored.map((s) => (JSON.parse(s) as UsageEvent).eventId)).toEqual(
      events.map((e) => e.eventId),
    );
    expect(bus.stats()).toEqual({ buffered: 0, published: 3, dropped: 0 });
  });

  it('buffers while Redis is down, retries with backoff, and drops only past the buffer limit', async () => {
    const { redis, state } = fakeRedis();
    const clock = new ManualClock();
    const { logger, lines } = captureLogger();
    const bus = new RedisStreamBus({ redis, logger, clock, bufferMax: 3, streamMaxLen: 1_000 });
    state.down = true;
    for (let i = 0; i < 5; i++) bus.publish(event());
    expect(bus.stats()).toEqual({ buffered: 3, published: 0, dropped: 2 });
    expect(lines.some((l) => l.msg === 'usage event buffer full, dropping events')).toBe(true);

    await vi.waitFor(() => expect(clock.pendingSleeps).toBe(1));
    await clock.advance(100);
    await vi.waitFor(() => expect(state.execs).toBe(2));

    state.down = false;
    await clock.advance(200);
    await vi.waitFor(() => expect(bus.stats()).toEqual({ buffered: 0, published: 3, dropped: 2 }));
    expect(state.stored).toHaveLength(3);
  });

  it('flushes on close and reports what it could not write', async () => {
    const { redis, state } = fakeRedis();
    const { logger, lines } = captureLogger();
    state.down = true;
    const bus = new RedisStreamBus({
      redis,
      logger,
      clock: new ManualClock(),
      bufferMax: 10,
      streamMaxLen: 1_000,
    });
    bus.publish(event());
    await bus.close(50);
    expect(
      lines.find((l) => l.msg === 'usage events still buffered at shutdown were lost'),
    ).toMatchObject({ lost: 1 });
  });
});
