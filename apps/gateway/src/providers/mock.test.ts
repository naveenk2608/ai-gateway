import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { ProviderError } from './errors.js';
import { MockProvider, type MockSettings } from './mock.js';
import type { ChatRequest, StreamEvent } from './types.js';

const defaults: MockSettings = {
  latencyMs: 0,
  ttftMs: 0,
  completionTokens: 4,
  errorRate: 0,
  seed: 1,
  retryAfterMs: 1_000,
};

const request: ChatRequest = {
  model: 'mock',
  messages: [{ role: 'user', content: 'Hello there!' }],
};

function mock(settings: Partial<MockSettings> = {}) {
  const clock = new ManualClock(0);
  return { clock, provider: new MockProvider({ ...defaults, ...settings }, clock) };
}

async function collect(stream: AsyncIterable<StreamEvent>, clock: ManualClock) {
  const events: { event: StreamEvent; at: number }[] = [];
  for await (const event of stream) events.push({ event, at: clock.now() });
  return events;
}

describe('MockProvider.chat', () => {
  it('answers after the configured latency with deterministic text and usage', async () => {
    const { clock, provider } = mock({ latencyMs: 300 });
    let settled = false;
    const pending = provider.chat(request, new AbortController().signal).finally(() => {
      settled = true;
    });

    await clock.advance(299);
    expect(settled).toBe(false);
    await clock.advance(1);

    expect(await pending).toEqual({
      content: 'This is a deterministic',
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    });
    expect(provider.stats()).toMatchObject({ requests: 1, completed: 1, active: 0 });
  });

  it('stops at max_tokens with finish reason "length"', async () => {
    const { clock, provider } = mock();
    const pending = provider.chat({ ...request, maxTokens: 2 }, new AbortController().signal);
    await clock.advance(0);
    const result = await pending;
    expect(result.content).toBe('This is');
    expect(result.finishReason).toBe('length');
    expect(result.usage?.completionTokens).toBe(2);
  });

  it('fails every request with a forced 429 carrying Retry-After', async () => {
    const { clock, provider } = mock({ failWith: 429, retryAfterMs: 2_500 });
    const pending = provider
      .chat(request, new AbortController().signal)
      .catch((err: unknown) => err);
    await clock.advance(0);
    const error = await pending;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 2_500, retryable: true });
    expect(provider.stats()).toMatchObject({ failed: 1, completed: 0 });
  });

  it('fails every request with a forced 500', async () => {
    const { clock, provider } = mock({ failWith: 500 });
    const pending = provider
      .chat(request, new AbortController().signal)
      .catch((err: unknown) => err);
    await clock.advance(0);
    expect(await pending).toMatchObject({ kind: 'server_error', upstreamStatus: 500 });
  });

  it('draws failures from a seeded RNG, so the same seed repeats the same sequence', async () => {
    const outcomes = async (seed: number) => {
      const { clock, provider } = mock({ errorRate: 0.5, seed });
      const results: string[] = [];
      for (let i = 0; i < 20; i++) {
        const pending = provider.chat(request, new AbortController().signal).then(
          () => 'ok',
          () => 'fail',
        );
        await clock.advance(0);
        results.push(await pending);
      }
      return results;
    };
    const first = await outcomes(42);
    expect(await outcomes(42)).toEqual(first);
    expect(first).toContain('ok');
    expect(first).toContain('fail');
    expect(await outcomes(7)).not.toEqual(first);
  });

  it('stops waiting and counts a cancel when the signal aborts', async () => {
    const { clock, provider } = mock({ latencyMs: 10_000 });
    const controller = new AbortController();
    const pending = provider.chat(request, controller.signal).catch((err: unknown) => err);
    await clock.advance(10);
    controller.abort(new Error('client gone'));
    expect(await pending).toMatchObject({ message: 'client gone' });
    expect(provider.stats()).toMatchObject({ canceled: 1, active: 0, completed: 0 });
  });
});

describe('MockProvider.chatStream', () => {
  it('sends the first token after ttftMs, then one token per 1000/tokensPerSecond ms', async () => {
    const { clock, provider } = mock({ ttftMs: 200, tokensPerSecond: 10 });
    const events = collect(provider.chatStream(request, new AbortController().signal), clock);
    await clock.advance(1_000);

    expect(await events).toEqual([
      { event: { type: 'content', text: 'This' }, at: 200 },
      { event: { type: 'content', text: ' is' }, at: 300 },
      { event: { type: 'content', text: ' a' }, at: 400 },
      { event: { type: 'content', text: ' deterministic' }, at: 500 },
      {
        event: {
          type: 'finish',
          finishReason: 'stop',
          usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        },
        at: 500,
      },
    ]);
    expect(provider.stats()).toMatchObject({ completed: 1, tokensEmitted: 4, active: 0 });
  });

  it('drops the connection after dropAfterTokens tokens', async () => {
    const { clock, provider } = mock({ completionTokens: 10, dropAfterTokens: 3 });
    const received: string[] = [];
    const run = (async () => {
      for await (const event of provider.chatStream(request, new AbortController().signal)) {
        if (event.type === 'content') received.push(event.text);
      }
    })().catch((err: unknown) => err);
    await clock.advance(0);
    expect(await run).toMatchObject({ kind: 'connection', retryable: true });
    expect(received).toEqual(['This', ' is', ' a']);
    expect(provider.stats()).toMatchObject({ failed: 1, tokensEmitted: 3 });
  });

  it('stops mid-stream when the signal aborts', async () => {
    const { clock, provider } = mock({ completionTokens: 100, tokensPerSecond: 10 });
    const controller = new AbortController();
    const iterator = provider.chatStream(request, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    await clock.advance(0);
    expect((await first).value).toEqual({ type: 'content', text: 'This' });

    const second = iterator.next().catch((err: unknown) => err);
    await clock.advance(50);
    controller.abort(new Error('client gone'));
    expect(await second).toMatchObject({ message: 'client gone' });
    expect(provider.stats()).toMatchObject({ canceled: 1, active: 0, tokensEmitted: 1 });
  });

  it('counts a consumer that stops reading early as canceled', async () => {
    const { clock, provider } = mock({ completionTokens: 5 });
    const iterator = provider
      .chatStream(request, new AbortController().signal)
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await clock.advance(0);
    await first;
    await iterator.return(undefined);
    expect(provider.stats()).toMatchObject({ canceled: 1, completed: 0, active: 0 });
  });
});

describe('MockProvider health and runtime changes', () => {
  it('probes unhealthy while every request is forced to fail, and heals on update', async () => {
    const { provider } = mock({ failWith: 500 });
    const signal = new AbortController().signal;
    await expect(provider.probe(signal)).rejects.toMatchObject({ kind: 'server_error' });
    provider.update({ failWith: undefined });
    await expect(provider.probe(signal)).resolves.toBeUndefined();
  });
});
