import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger, sleepsQueued } from '../../test/helpers.js';
import { ProviderError } from '../providers/errors.js';
import { MockProvider, type MockSettings } from '../providers/mock.js';
import type { Deployment } from '../providers/registry.js';
import type { ChatRequest, Provider } from '../providers/types.js';
import { ClientClosedError, openStream, runChat, type AttemptContext } from './attempt.js';

const request: ChatRequest = { model: 'mock', messages: [{ role: 'user', content: 'hi' }] };

function setup(settings: Partial<MockSettings> = {}, timeouts = { timeoutMs: 1_000, idle: 500 }) {
  const clock = new ManualClock(0);
  const { logger, lines } = captureLogger();
  const mock = new MockProvider(
    {
      latencyMs: 0,
      ttftMs: 0,
      completionTokens: 3,
      errorRate: 0,
      seed: 1,
      retryAfterMs: 0,
      ...settings,
    },
    clock,
  );
  const client = new AbortController();
  const deployment: Deployment = {
    id: 'mock-a',
    provider: mock,
    providerModel: 'mock',
    timeoutMs: timeouts.timeoutMs,
    streamIdleTimeoutMs: timeouts.idle,
    maxOutputTokens: 4_096,
  };
  const ctx: AttemptContext = { deployment, clock, clientSignal: client.signal, log: logger };
  return { clock, mock, client, ctx, lines };
}

describe('runChat', () => {
  it('returns the result and logs one line with an attemptId', async () => {
    const { clock, ctx, lines } = setup({ latencyMs: 100 });
    const pending = runChat(ctx, request);
    await sleepsQueued(clock, 2);
    await clock.advance(100);
    expect((await pending).content).toBe('This is a');
    const line = lines.find((l) => l.msg === 'provider attempt finished');
    expect(line).toMatchObject({
      deployment: 'mock-a',
      provider: 'mock',
      outcome: 'ok',
      durationMs: 100,
    });
    expect(line?.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('times out after timeoutMs and aborts the provider call', async () => {
    const { clock, mock, ctx, lines } = setup({ latencyMs: 5_000 });
    const pending = runChat(ctx, request).catch((err: unknown) => err);
    await sleepsQueued(clock, 2);
    await clock.advance(1_000);
    const error = await pending;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
    expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 });
    expect(lines.find((l) => l.msg === 'provider attempt failed')).toMatchObject({
      outcome: 'timeout',
    });
  });

  it('reports a client disconnect as canceled and stops the provider', async () => {
    const { clock, mock, client, ctx } = setup({ latencyMs: 5_000 });
    const pending = runChat(ctx, request).catch((err: unknown) => err);
    await sleepsQueued(clock, 2);
    client.abort(new ClientClosedError());
    expect(await pending).toMatchObject({ kind: 'canceled' });
    expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 });
  });

  it('times out even when a provider ignores the abort signal', async () => {
    const { clock, ctx } = setup();
    const stubborn: Provider = {
      kind: 'mock',
      chat: () => new Promise(() => undefined),
      chatStream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      }),
      probe: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const pending = runChat(
      { ...ctx, deployment: { ...ctx.deployment, provider: stubborn } },
      request,
    ).catch((err: unknown) => err);
    await sleepsQueued(clock, 1);
    await clock.advance(1_000);
    expect(await pending).toMatchObject({ kind: 'timeout' });
  });

  it('passes provider errors through unchanged', async () => {
    const { clock, ctx } = setup({ failWith: 500 });
    const pending = runChat(ctx, request).catch((err: unknown) => err);
    await sleepsQueued(clock, 2);
    await clock.advance(0);
    expect(await pending).toMatchObject({ kind: 'server_error', upstreamStatus: 500 });
  });
});

describe('openStream', () => {
  it('waits for the first event within timeoutMs', async () => {
    const { clock, mock, ctx } = setup({ ttftMs: 2_000 });
    const pending = openStream(ctx, request).catch((err: unknown) => err);
    await sleepsQueued(clock, 2);
    await clock.advance(1_000);
    expect(await pending).toMatchObject({ kind: 'timeout' });
    expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 });
  });

  it('fails a stream that goes quiet for longer than the idle timeout', async () => {
    const { clock, mock, ctx } = setup({ tokensPerSecond: 1 }); // a token every 1000 ms > 500 ms idle
    const opened = openStream(ctx, request);
    await sleepsQueued(clock, 2);
    await clock.advance(0);
    const stream = await opened;
    expect(stream.first.value).toEqual({ type: 'content', text: 'This' });

    const next = stream.next().catch((err: unknown) => err);
    await sleepsQueued(clock, 2);
    await clock.advance(500);
    expect(await next).toMatchObject({ kind: 'timeout' });
    stream.close(await next);
    expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 });
  });

  it('close() stops a provider that is still streaming', async () => {
    const { clock, mock, ctx, lines } = setup({ completionTokens: 50, tokensPerSecond: 10 });
    const opened = openStream(ctx, request);
    await sleepsQueued(clock, 2);
    await clock.advance(0);
    const stream = await opened;
    stream.close(new ProviderError('canceled', 'client went away'));
    await clock.advance(0);
    expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 });
    expect(lines.find((l) => l.msg === 'provider attempt finished')).toMatchObject({
      outcome: 'canceled',
      stream: true,
    });
  });
});
