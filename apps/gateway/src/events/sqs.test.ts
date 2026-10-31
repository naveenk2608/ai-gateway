import { ManualClock, uuidv7, type UsageEvent } from '@ai-gateway/shared';
import type { SqsApi } from '@ai-gateway/shared/node';
import { describe, expect, it, vi } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { SqsBus } from './sqs.js';

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/usage';

function event(n: number): UsageEvent {
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
      model: `m${n}`,
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

const modelOf = (body: string) => (JSON.parse(body) as UsageEvent).request.model;

/** An SQS stand-in: `down` fails whole calls, `reject` refuses the bodies it matches. */
function fakeSqs() {
  const state = {
    down: false,
    reject: (_body: string) => false,
    stored: [] as string[],
    calls: [] as { queueUrl: string; count: number }[],
  };
  const sqs = {
    sendBatch: (queueUrl: string, bodies: string[]) => {
      state.calls.push({ queueUrl, count: bodies.length });
      if (state.down) return Promise.reject(new Error('connect ETIMEDOUT'));
      const failed: number[] = [];
      bodies.forEach((body, i) => (state.reject(body) ? failed.push(i) : state.stored.push(body)));
      return Promise.resolve(failed);
    },
  } as Partial<SqsApi> as SqsApi;
  return { sqs, state };
}

describe('SqsBus', () => {
  it('sends buffered events to the queue without blocking the caller', async () => {
    const { sqs, state } = fakeSqs();
    const bus = new SqsBus({
      sqs,
      queueUrl: QUEUE,
      logger: captureLogger().logger,
      clock: new ManualClock(0),
      bufferMax: 100,
    });
    for (let i = 0; i < 25; i++) bus.publish(event(i));
    expect(bus.stats().buffered).toBe(25);
    await bus.close(1_000);
    expect(state.stored.map(modelOf)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));
    expect(state.calls.every((c) => c.queueUrl === QUEUE)).toBe(true);
    expect(bus.stats()).toEqual({ buffered: 0, published: 25, dropped: 0 });
  });

  it('retries only the events SQS did not accept', async () => {
    const { sqs, state } = fakeSqs();
    const clock = new ManualClock(0);
    const { logger, lines } = captureLogger();
    const bus = new SqsBus({ sqs, queueUrl: QUEUE, logger, clock, bufferMax: 100 });
    let refusals = 1;
    state.reject = (body) => modelOf(body) === 'm1' && refusals-- > 0;
    for (let i = 0; i < 3; i++) bus.publish(event(i));
    await vi.waitFor(() => expect(state.stored).toHaveLength(2));
    expect(bus.stats()).toMatchObject({ buffered: 1, published: 2 });
    expect(lines.some((l) => l.msg === 'some usage events were not accepted by SQS')).toBe(true);

    await vi.waitFor(() => expect(clock.pendingSleeps).toBe(1));
    await clock.advance(100);
    await bus.close(1_000);
    expect(state.stored.map(modelOf).sort()).toEqual(['m0', 'm1', 'm2']);
    expect(bus.stats()).toEqual({ buffered: 0, published: 3, dropped: 0 });
  });

  it('keeps events while SQS is unreachable, then drops and counts what does not fit', async () => {
    const { sqs, state } = fakeSqs();
    state.down = true;
    const clock = new ManualClock(0);
    const { logger, lines } = captureLogger();
    const bus = new SqsBus({ sqs, queueUrl: QUEUE, logger, clock, bufferMax: 3 });
    for (let i = 0; i < 5; i++) bus.publish(event(i));
    await vi.waitFor(() => expect(state.calls.length).toBeGreaterThan(0));
    expect(bus.stats()).toEqual({ buffered: 3, published: 0, dropped: 2 });
    expect(lines.some((l) => l.msg === 'usage event buffer full, dropping events')).toBe(true);

    state.down = false;
    await vi.waitFor(() => expect(clock.pendingSleeps).toBe(1));
    await clock.advance(100);
    await bus.close(1_000);
    expect(state.stored.map(modelOf)).toEqual(['m0', 'm1', 'm2']);
    expect(bus.stats()).toEqual({ buffered: 0, published: 3, dropped: 2 });
  });
});
