import { systemClock } from '@ai-gateway/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider, type MockSettings } from '../providers/mock.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { ChatRequest, StreamEvent } from '../providers/types.js';
import { startMockServer, type MockServer } from './server.js';

const defaults: MockSettings = {
  latencyMs: 0,
  ttftMs: 0,
  completionTokens: 4,
  errorRate: 0,
  seed: 1,
  retryAfterMs: 1_000,
};

const body = {
  model: 'bench-model',
  messages: [{ role: 'user', content: 'Hello there!' }],
};

let server: MockServer | undefined;

async function start(settings: Partial<MockSettings> = {}) {
  server = await startMockServer({
    settings: { ...defaults, ...settings },
    clock: systemClock,
    host: '127.0.0.1',
    port: 0,
  });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function post(url: string, payload: unknown, init: RequestInit = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...init,
  });
}

/** The `data:` payloads of an SSE body, in order. */
function sseData(text: string): string[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('mock provider over HTTP', () => {
  it('answers a non-streaming request in the OpenAI format with usage', async () => {
    const { url } = await start();
    const res = await post(url, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: expect.stringMatching(/^chatcmpl-mock-\d+$/) as unknown,
      object: 'chat.completion',
      model: 'bench-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'This is a deterministic' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
  });

  it('streams one chunk per token, a finish chunk, usage when asked, then [DONE]', async () => {
    const { url } = await start();
    const res = await post(url, { ...body, stream: true, stream_options: { include_usage: true } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const data = sseData(await res.text());
    expect(data.at(-1)).toBe('[DONE]');
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d) as Record<string, unknown>);
    type Chunk = { choices: { delta: { content?: string }; finish_reason: string | null }[] };
    const text = (chunks as Chunk[])
      .flatMap((c) => c.choices.map((choice) => choice.delta.content ?? ''))
      .join('');
    expect(text).toBe('This is a deterministic');
    expect(chunks).toHaveLength(6);
    expect(chunks[4]).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(chunks[5]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
  });

  it('sends no usage chunk unless stream_options.include_usage is set', async () => {
    const { url } = await start();
    const data = sseData(await (await post(url, { ...body, stream: true })).text());
    expect(data).toHaveLength(6);
    expect(data.some((d) => d.includes('"usage"'))).toBe(false);
  });

  it('stops at max_tokens with finish reason "length"', async () => {
    const { url } = await start();
    const res = await post(url, { ...body, max_tokens: 2 });
    expect(await res.json()).toMatchObject({
      choices: [{ message: { content: 'This is' }, finish_reason: 'length' }],
      usage: { completion_tokens: 2 },
    });
  });

  it('answers a forced 429 with Retry-After in seconds and an OpenAI error body', async () => {
    const { url } = await start({ failWith: 429, retryAfterMs: 2_500 });
    const res = await post(url, { ...body, stream: true });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toEqual({
      error: {
        message: 'mock forced 429',
        type: 'requests',
        param: null,
        code: 'rate_limit_exceeded',
      },
    });
  });

  it('answers a forced 500 with an error body', async () => {
    const { url, provider } = await start({ failWith: 500 });
    const res = await post(url, body);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { type: 'server_error' } });
    expect(provider.stats()).toMatchObject({ requests: 1, failed: 1 });
  });

  it('cuts the connection mid-stream when set to drop, after the tokens so far', async () => {
    const { url, provider } = await start({ completionTokens: 8, dropAfterTokens: 3 });
    const res = await post(url, { ...body, stream: true });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let received = '';
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          received += decoder.decode(value, { stream: true });
        }
      })(),
    ).rejects.toThrow();
    expect(sseData(received)).toHaveLength(3);
    expect(received).not.toContain('[DONE]');
    expect(provider.stats()).toMatchObject({ failed: 1, tokensEmitted: 3 });
  });

  it('aborts the provider when the caller hangs up', async () => {
    const { url, provider } = await start({ latencyMs: 10_000 });
    const controller = new AbortController();
    const pending = post(url, body, { signal: controller.signal }).catch(() => undefined);
    await expect.poll(() => provider.stats().active).toBe(1);
    controller.abort();
    await pending;
    await expect.poll(() => provider.stats().canceled).toBe(1);
  });

  it('rejects invalid requests, unknown paths and wrong methods', async () => {
    const { url } = await start();
    expect((await post(url, { model: 'x', messages: [] })).status).toBe(400);
    expect((await fetch(`${url}/v1/chat/completions`)).status).toBe(405);
    expect((await fetch(`${url}/v1/embeddings`)).status).toBe(404);
  });

  it('lists a model for health checks and reports its counters', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/v1/models`)).status).toBe(200);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await post(url, body);
    expect(await (await fetch(`${url}/stats`)).json()).toMatchObject({
      requests: 1,
      completed: 1,
      tokensEmitted: 4,
    });
  });
});

describe('the gateway adapter against the mock server', () => {
  const request: ChatRequest = {
    model: 'bench-model',
    messages: [{ role: 'user', content: 'Hello there!' }],
    maxTokens: 3,
  };

  async function adapterAndInProcess() {
    const { url } = await start({ completionTokens: 5 });
    const adapter = new OpenAICompatibleProvider({
      baseUrl: `${url}/v1`,
      apiKey: 'bench-not-a-secret',
      clock: systemClock,
    });
    const inProcess = new MockProvider({ ...defaults, completionTokens: 5 }, systemClock);
    return { adapter, inProcess };
  }

  it('returns what the in-process mock returns, without streaming', async () => {
    const { adapter, inProcess } = await adapterAndInProcess();
    try {
      const signal = new AbortController().signal;
      expect(await adapter.chat(request, signal)).toEqual(await inProcess.chat(request, signal));
      await expect(adapter.probe(signal)).resolves.toBeUndefined();
    } finally {
      await adapter.close();
    }
  });

  it('returns what the in-process mock returns, streaming', async () => {
    const { adapter, inProcess } = await adapterAndInProcess();
    try {
      const signal = new AbortController().signal;
      expect(await collect(adapter.chatStream(request, signal))).toEqual(
        await collect(inProcess.chatStream(request, signal)),
      );
    } finally {
      await adapter.close();
    }
  });
});
