import { systemClock } from '@ai-gateway/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openAIStream,
  sendJson,
  startFakeUpstream,
  type FakeHandler,
  type FakeUpstream,
} from '../../test/fake-upstream.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ChatRequest, StreamEvent } from './types.js';

const request: ChatRequest = {
  model: 'upstream-model',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
  ],
  maxTokens: 50,
  temperature: 0.2,
  stop: ['END'],
};

const completion = {
  id: 'up-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
};

let upstream: FakeUpstream | undefined;
let provider: OpenAICompatibleProvider | undefined;

async function setup(handler: FakeHandler, options: { maxResponseBytes?: number } = {}) {
  upstream = await startFakeUpstream(handler);
  provider = new OpenAICompatibleProvider({
    baseUrl: `${upstream.url}/v1/`,
    apiKey: 'test-key-not-secret',
    clock: systemClock,
    ...options,
  });
  return { upstream, provider };
}

afterEach(async () => {
  await provider?.close();
  await upstream?.close();
  provider = undefined;
  upstream = undefined;
});

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const signal = () => new AbortController().signal;

describe('OpenAICompatibleProvider.chat', () => {
  it('posts an OpenAI request with the bearer key and parses the completion', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, completion));
    expect(await provider.chat(request, signal())).toEqual({
      content: 'Hello!',
      finishReason: 'stop',
      usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 },
    });

    const sent = upstream.requests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer test-key-not-secret');
    expect(JSON.parse(sent.body)).toEqual({
      model: 'upstream-model',
      messages: request.messages,
      stream: false,
      max_tokens: 50,
      temperature: 0.2,
      stop: ['END'],
    });
  });

  it.each([
    [429, 'rate_limited', true],
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'not_found', false],
    [400, 'bad_request', false],
    [500, 'server_error', true],
    [503, 'server_error', true],
  ] as const)('normalizes upstream status %i to %s', async (status, kind, retryable) => {
    const { provider } = await setup((_req, res) =>
      sendJson(res, status, { error: { message: 'Secret prompt text echoed', code: 'some_code' } }),
    );
    const error = await provider.chat(request, signal()).catch((err: unknown) => err);
    expect(error).toMatchObject({
      kind,
      retryable,
      upstreamStatus: status,
      upstreamCode: 'some_code',
    });
    expect(String(error)).not.toContain('Secret prompt text');
  });

  it('reads Retry-After on a 429', async () => {
    const { provider } = await setup((_req, res) =>
      sendJson(res, 429, { error: { type: 'requests' } }, { 'retry-after': '7' }),
    );
    await expect(provider.chat(request, signal())).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 7_000,
    });
  });

  it('rejects invalid JSON and unexpected shapes as invalid_response', async () => {
    const bad = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices": [');
    });
    await expect(bad.provider.chat(request, signal())).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    await bad.provider.close();
    await bad.upstream.close();

    const odd = await setup((_req, res) => sendJson(res, 200, { choices: [] }));
    await expect(odd.provider.chat(request, signal())).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('rejects a response body over the size limit', async () => {
    const { provider } = await setup((_req, res) => sendJson(res, 200, completion), {
      maxResponseBytes: 32,
    });
    await expect(provider.chat(request, signal())).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('reports a refused connection as connection', async () => {
    const { upstream, provider: unused } = await setup(() => undefined);
    await unused.close();
    await upstream.close();
    const offline = new OpenAICompatibleProvider({
      baseUrl: upstream.url,
      apiKey: 'test-key-not-secret',
      clock: systemClock,
    });
    provider = offline;
    await expect(offline.chat(request, signal())).rejects.toMatchObject({
      kind: 'connection',
      retryable: true,
    });
  });
});

describe('OpenAICompatibleProvider.chatStream', () => {
  it('asks for usage in the final chunk and yields content, then one finish with usage', async () => {
    const { upstream, provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(openAIStream(['Hel', 'lo', '!']));
    });
    expect(await collect(provider.chatStream(request, signal()))).toEqual([
      { type: 'content', text: 'Hel' },
      { type: 'content', text: 'lo' },
      { type: 'content', text: '!' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      },
    ]);
    const body = JSON.parse(upstream.requests[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(upstream.requests[0]!.headers.accept).toBe('text/event-stream');
  });

  it('treats a stream that ends without a finish_reason as interrupted', async () => {
    const { provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] })}\n\n`,
      );
    });
    const events: StreamEvent[] = [];
    const error = await (async () => {
      for await (const event of provider.chatStream(request, signal())) events.push(event);
    })().catch((err: unknown) => err);
    expect(events).toEqual([{ type: 'content', text: 'partial' }]);
    expect(error).toMatchObject({ kind: 'connection' });
  });

  it('turns an error event from the upstream into server_error', async () => {
    const { provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ error: { message: 'overloaded' } })}\n\n`);
    });
    await expect(collect(provider.chatStream(request, signal()))).rejects.toMatchObject({
      kind: 'server_error',
    });
  });

  it('closes the upstream connection when the signal aborts mid-stream', async () => {
    const { upstream, provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(openAIStream(['first']).split('\n\n').slice(0, 2).join('\n\n') + '\n\n');
      // ...and then never finishes on its own.
    });
    const controller = new AbortController();
    const iterator = provider.chatStream(request, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'content', text: 'first' });

    const next = iterator.next().catch((err: unknown) => err);
    controller.abort(new Error('client gone'));
    expect(await next).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(upstream.closedEarly).toBe(1));
  });
});

describe('OpenAICompatibleProvider.probe', () => {
  it('lists models with the key, which runs no model', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, { data: [] }));
    await provider.probe(signal());
    expect(upstream.requests[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
    expect(upstream.requests[0]?.headers.authorization).toBe('Bearer test-key-not-secret');
  });

  it('fails with the normalized error for the status', async () => {
    const { provider } = await setup((_req, res) => sendJson(res, 503, { error: 'down' }));
    await expect(provider.probe(signal())).rejects.toMatchObject({ kind: 'server_error' });
  });
});
