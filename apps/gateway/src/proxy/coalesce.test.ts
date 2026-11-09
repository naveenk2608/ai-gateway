import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  sleepsQueued,
  sseData,
  testAdmission,
  testRouting,
} from '../../test/helpers.js';
import { buildApp } from '../app.js';
import { parseModelsConfig } from '../models-config.js';
import { ProviderError } from '../providers/errors.js';
import type { MockProvider } from '../providers/mock.js';
import { createRegistry } from '../providers/registry.js';
import type { ChatResult, StreamEvent } from '../providers/types.js';
import type { OpenStream } from './attempt.js';
import { registerChatCompletions } from './chat-completions.js';
import { Coalescer, follow, shareStream } from './coalesce.js';
import { RequestTrace } from './trace.js';

const answer: ChatResult = {
  content: 'hi',
  finishReason: 'stop',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
};

describe('Flight', () => {
  it('aborts its call only when every participant has left', () => {
    const coalescer = new Coalescer(true);
    const { flight, leader } = coalescer.join<ChatResult>('k');
    expect(leader).toBe(true);
    const leaveLeader = flight.enter('leader');
    const leaveA = flight.enter('follower');
    const leaveB = flight.enter('follower');
    leaveLeader();
    leaveA();
    expect(flight.signal.aborted).toBe(false);
    expect(flight.followersWaiting).toBe(1);
    leaveB();
    expect(flight.signal.aborted).toBe(true);
    // A flight everyone left is not joined: the next request leads a new one.
    expect(coalescer.join('k').leader).toBe(true);
  });

  it('is followed while it runs and leaves the map once it has its answer', async () => {
    const clock = new ManualClock();
    const coalescer = new Coalescer(true);
    const lead = coalescer.join<ChatResult>('k');
    const second = coalescer.join<ChatResult>('k');
    expect(second).toMatchObject({ leader: false });
    expect(second.flight).toBe(lead.flight);
    expect(coalescer.join('other').leader).toBe(true);
    const waiting = follow(second.flight, { clock, clientSignal: new AbortController().signal });
    lead.flight.resolve(answer);
    await expect(waiting).resolves.toBe(answer);
    expect(coalescer.join('k').leader).toBe(true);
  });

  it("gives every follower the leader's error", async () => {
    const clock = new ManualClock();
    const { flight } = new Coalescer(true).join<ChatResult>('k');
    const signal = new AbortController().signal;
    const waits = [
      follow(flight, { clock, clientSignal: signal }),
      follow(flight, { clock, clientSignal: signal }),
    ];
    flight.reject(new ProviderError('server_error', 'down'));
    for (const w of waits) await expect(w).rejects.toMatchObject({ kind: 'server_error' });
  });

  it('lets a follower leave or reach its own deadline without affecting the others', async () => {
    const clock = new ManualClock();
    const { flight } = new Coalescer(true).join<ChatResult>('k');
    const leaveLeader = flight.enter('leader');
    const gone = new AbortController();
    const leaving = follow(flight, { clock, clientSignal: gone.signal });
    const hurried = follow(flight, {
      clock,
      clientSignal: new AbortController().signal,
      deadlineAt: clock.now() + 1_000,
    });
    const patient = follow(flight, { clock, clientSignal: new AbortController().signal });
    gone.abort();
    await expect(leaving).rejects.toMatchObject({ kind: 'canceled' });
    const timedOut = expect(hurried).rejects.toMatchObject({ kind: 'timeout' });
    await clock.advance(1_000);
    await timedOut;
    expect(flight.signal.aborted).toBe(false);
    flight.resolve(answer);
    await expect(patient).resolves.toBe(answer);
    leaveLeader();
  });
});

describe('shareStream', () => {
  function fakeStream(events: StreamEvent[]) {
    const queue = [...events];
    const closed: unknown[] = [];
    const stream: OpenStream = {
      first: { done: false, value: queue.shift()! },
      next: () => {
        const value = queue.shift();
        return Promise.resolve(
          value === undefined ? { done: true, value: undefined } : { done: false, value },
        );
      },
      close: (error?: unknown) => closed.push(error ?? 'ok'),
    };
    return { stream, closed };
  }
  const events: StreamEvent[] = [
    { type: 'content', text: 'Hel' },
    { type: 'content', text: 'lo' },
    { type: 'finish', finishReason: 'stop', usage: answer.usage },
  ];
  const trace = () =>
    new RequestTrace(
      {
        requestId: '0192f000-0000-7000-8000-000000000001',
        projectId: '0192f000-0000-7000-8000-000000000002',
        apiKeyId: null,
        model: 'm',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
      new ManualClock(),
    );

  it('assembles the answer as the leader reads it, for the flight and the cache', async () => {
    const { flight } = new Coalescer(true).join<ChatResult>('k');
    const { stream, closed } = fakeStream(events);
    const stored: ChatResult[] = [];
    const shared = shareStream(stream, flight, trace(), { onAnswer: (r) => stored.push(r) });
    while (!(await shared.next()).done);
    shared.close();
    const expected = { content: 'Hello', finishReason: 'stop', usage: answer.usage };
    await expect(flight.result).resolves.toEqual(expected);
    expect(stored).toEqual([expected]);
    expect(closed).toEqual(['ok']);
  });

  it("reads the rest for the followers when the leader's client leaves", async () => {
    const { flight } = new Coalescer(true).join<ChatResult>('k');
    const waiting = follow(flight, {
      clock: new ManualClock(),
      clientSignal: new AbortController().signal,
    });
    const { stream, closed } = fakeStream(events);
    const t = trace();
    const shared = shareStream(stream, flight, t);
    const ended: string[] = [];
    // The leader's client left after the first event.
    shared.close(new ProviderError('canceled', 'client closed the stream'));
    shared.whenClosed(() => ended.push('leader recorded'));
    await expect(waiting).resolves.toMatchObject({ content: 'Hello' });
    await Promise.resolve();
    expect(ended).toEqual(['leader recorded']);
    // Closed as a success: the call ran to its end, and its usage is on the leader's record.
    expect(closed).toEqual(['ok']);
    expect(t.usage()).toMatchObject({ usageSource: 'reported', usage: answer.usage });
  });

  it('stops at once when the leader leaves and nobody waits', () => {
    const { flight } = new Coalescer(true).join<ChatResult>('k');
    const { stream, closed } = fakeStream(events);
    const shared = shareStream(stream, flight, trace());
    const canceled = new ProviderError('canceled', 'client closed the stream');
    shared.close(canceled);
    expect(closed).toEqual([canceled]);
  });
});

describe('coalescing on POST /v1/chat/completions', () => {
  function setup() {
    const clock = new ManualClock(Date.UTC(2026, 10, 8, 12, 0, 0));
    const { logger } = captureLogger();
    const models = parseModelsConfig(
      {
        deployments: {
          fast: { provider: 'mock', mock: { latencyMs: 100, completionTokens: 5 } },
          broken: { provider: 'mock', mock: { latencyMs: 100, failWith: 500 } },
        },
        models: { 'mock-fast': { deployment: 'fast' }, 'mock-broken': { deployment: 'broken' } },
      },
      'test',
    );
    const registry = createRegistry(models, {
      clock,
      logger,
      env: {},
      ollamaBaseUrl: 'http://127.0.0.1:1',
    });
    const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
    const { verifier, authorization } = inMemoryVerifier(clock);
    const events = new RecordingBus();
    registerChatCompletions(app, {
      registry,
      clock,
      verifier,
      events,
      admission: testAdmission(clock, logger),
      // Each follower waits on its own deadline, so its sleep shows it has joined.
      routing: testRouting(registry, clock, { deadlineMs: 60_000 }),
      coalescer: new Coalescer(true),
    });
    const post = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization },
        payload,
      });
    const mock = (id: string) => registry.deployment(id)?.provider as MockProvider;
    return { clock, post, events, mock };
  }
  const body = (model: string, stream = false) => ({
    model,
    messages: [{ role: 'user', content: 'Say hello' }],
    temperature: 0,
    stream,
  });

  it('answers 50 identical concurrent requests with one upstream call', async () => {
    const { clock, post, events, mock } = setup();
    const leader = post(body('mock-fast'));
    // The leader's mock latency and its try's timeout.
    await sleepsQueued(clock, 2);
    const followers = Array.from({ length: 49 }, (_, i) => post(body('mock-fast', i % 3 === 0)));
    await sleepsQueued(clock, 2 + 49);
    await clock.advance(100);
    const replies = await Promise.all([leader, ...followers]);
    expect(mock('fast').stats().requests).toBe(1);
    expect(replies.map((r) => r.statusCode)).toEqual(Array(50).fill(200));
    const first = replies[0].json<{ choices: { message: { content: string } }[] }>();
    const content = first.choices[0]!.message.content;
    expect(replies[0].headers['x-gateway-cache']).toBeUndefined();
    for (const [i, reply] of replies.slice(1).entries()) {
      expect(reply.headers['x-gateway-cache']).toBe('coalesced');
      if (i % 3 === 0) {
        const data = sseData(reply.body);
        expect(data.at(-1)).toBe('[DONE]');
        const text = data
          .slice(0, -1)
          .map((e) => JSON.parse(e) as { choices: { delta: { content?: string } }[] })
          .map((c) => c.choices[0]?.delta.content ?? '')
          .join('');
        expect(text).toBe(content);
      } else {
        expect(reply.json()).toMatchObject({ choices: [{ message: { content } }] });
      }
    }
    expect(events.events).toHaveLength(50);
    const coalesced = events.events.filter((e) => e.coalesced === true);
    expect(coalesced).toHaveLength(49);
    for (const e of coalesced) {
      expect(e.attempts).toEqual([]);
      expect(e.request.status).toBe('success');
      expect(e.usage).toEqual(events.events.find((x) => !x.coalesced)!.usage);
    }
    expect(events.events.filter((e) => e.attempts.length === 1)).toHaveLength(1);
  });

  it("gives every follower the leader's failure, without calling again", async () => {
    const { clock, post, events, mock } = setup();
    const leader = post(body('mock-broken'));
    await sleepsQueued(clock, 2);
    const followers = Array.from({ length: 4 }, () => post(body('mock-broken')));
    await sleepsQueued(clock, 2 + 4);
    await clock.advance(100);
    const replies = await Promise.all([leader, ...followers]);
    expect(mock('broken').stats().requests).toBe(1);
    for (const reply of replies) {
      expect(reply.statusCode).toBe(502);
      expect(reply.json()).toMatchObject({ error: { code: 'upstream_error' } });
    }
    const coalesced = events.events.filter((e) => e.coalesced === true);
    expect(coalesced).toHaveLength(4);
    for (const e of coalesced) {
      expect(e.request).toMatchObject({ status: 'error', errorCode: 'upstream_error' });
    }
  });

  it('leaves sampled requests alone', async () => {
    const { clock, post, mock } = setup();
    const sampled = { ...body('mock-fast'), temperature: 0.7 };
    const a = post(sampled);
    const b = post(sampled);
    await sleepsQueued(clock, 4);
    await clock.advance(100);
    await Promise.all([a, b]);
    expect(mock('fast').stats().requests).toBe(2);
  });
});
