import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger, inMemoryVerifier, sleepsQueued, sseData } from '../../test/helpers.js';
import { buildApp } from '../app.js';
import { parseModelsConfig } from '../models-config.js';
import type { MockProvider } from '../providers/mock.js';
import { createRegistry } from '../providers/registry.js';
import { registerChatCompletions } from './chat-completions.js';

const deployments = {
  fast: { provider: 'mock', mock: { latencyMs: 100, completionTokens: 5 } },
  slow: { provider: 'mock', timeoutMs: 1_000, mock: { latencyMs: 30_000 } },
  limited: { provider: 'mock', mock: { failWith: 429, retryAfterMs: 2_500 } },
  broken: { provider: 'mock', mock: { failWith: 500 } },
  stream: { provider: 'mock', mock: { completionTokens: 3 } },
  'stream-ttft': { provider: 'mock', timeoutMs: 1_000, mock: { ttftMs: 5_000 } },
  'stream-idle': {
    provider: 'mock',
    streamIdleTimeoutMs: 500,
    mock: { tokensPerSecond: 1, completionTokens: 3 },
  },
  'stream-drop': { provider: 'mock', mock: { completionTokens: 10, dropAfterTokens: 2 } },
};

function setup() {
  const clock = new ManualClock(Date.UTC(2026, 9, 20, 12, 0, 0));
  const { logger, lines } = captureLogger();
  const models = parseModelsConfig(
    {
      deployments,
      models: {
        'mock-fast': { deployment: 'fast' },
        'mock-slow': { deployment: 'slow' },
        'mock-limited': { deployment: 'limited' },
        'mock-broken': { deployment: 'broken' },
        'mock-stream': { deployment: 'stream' },
        'mock-stream-ttft': { deployment: 'stream-ttft' },
        'mock-stream-idle': { deployment: 'stream-idle' },
        'mock-stream-drop': { deployment: 'stream-drop' },
      },
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
  registerChatCompletions(app, { registry, clock, verifier });

  /** Sends a request, then advances the manual clock once its sleeps are queued. */
  async function post(payload: unknown, { sleeps = 2, advance = 0 } = {}) {
    const pending = Promise.resolve(
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization },
        payload: payload as object,
      }),
    );
    if (sleeps > 0) {
      await sleepsQueued(clock, sleeps);
      await clock.advance(advance);
    }
    return pending;
  }
  return { app, clock, registry, lines, post, authorization };
}

const hello = { messages: [{ role: 'user', content: 'Say hello' }] };

describe('POST /v1/chat/completions (non-streaming)', () => {
  it('returns an OpenAI chat.completion for the logical model', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-fast', ...hello }, { advance: 100 });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual({
      id: `chatcmpl-${res.headers['x-request-id'] as string}`,
      object: 'chat.completion',
      created: Date.UTC(2026, 9, 20, 12, 0, 0) / 1000,
      model: 'mock-fast',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'This is a deterministic response',
            refusal: null,
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    });
  });

  it('honours max_tokens with finish_reason "length"', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-fast', ...hello, max_tokens: 2 }, { advance: 100 });
    const body = res.json<{
      choices: { finish_reason: string }[];
      usage: { completion_tokens: number };
    }>();
    expect(body.choices[0]?.finish_reason).toBe('length');
    expect(body.usage.completion_tokens).toBe(2);
  });

  it('accepts null for optional parameters, as OpenAI does', async () => {
    const { post } = setup();
    const res = await post(
      {
        model: 'mock-fast',
        ...hello,
        temperature: null,
        stop: null,
        max_tokens: null,
        stream: false,
      },
      { advance: 100 },
    );
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 model_not_found for an unknown model', async () => {
    const { post } = setup();
    const res = await post({ model: 'gpt-unknown', ...hello }, { sleeps: 0 });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        message: 'The model `gpt-unknown` does not exist.',
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_not_found',
      },
    });
  });

  it('maps an upstream 429 to 429 with Retry-After, never exposing provider details', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-limited', ...hello });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.headers['x-should-retry']).toBe('true');
    expect(res.json()).toEqual({
      error: {
        message: 'The model provider is rate limiting requests. Retry later.',
        type: 'rate_limit_error',
        param: null,
        code: 'upstream_rate_limited',
      },
    });
    expect(res.body).not.toMatch(/mock/i);
  });

  it('maps an upstream 500 to 502 upstream_error', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-broken', ...hello });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'upstream_error', type: 'server_error' } });
  });

  it('returns 504 when the attempt exceeds the deployment timeout, and stops the provider', async () => {
    const { post, registry } = setup();
    const res = await post({ model: 'mock-slow', ...hello }, { advance: 1_000 });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
    const mock = registry.deployment('slow')?.provider as MockProvider;
    expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 });
  });
});

describe('POST /v1/chat/completions validation', () => {
  const cases: [string, unknown, string | null, RegExp][] = [
    ['missing messages', { model: 'mock-fast' }, 'messages', /messages/],
    ['empty messages', { model: 'mock-fast', messages: [] }, 'messages', /messages/],
    [
      'unsupported role',
      { model: 'mock-fast', messages: [{ role: 'tool', content: 'x' }] },
      'messages[0].role',
      /messages\[0\]\.role/,
    ],
    [
      'temperature out of range',
      { model: 'mock-fast', ...hello, temperature: 3 },
      'temperature',
      /temperature/,
    ],
    ['n > 1', { model: 'mock-fast', ...hello, n: 2 }, 'n', /only n = 1 is supported/],
    ['unknown field', { model: 'mock-fast', ...hello, tools: [] }, 'tools', /Unrecognized key/],
    [
      'stream_options without stream',
      { model: 'mock-fast', ...hello, stream_options: { include_usage: true } },
      'stream_options',
      /only allowed when stream is true/,
    ],
    [
      'max_tokens and max_completion_tokens',
      { model: 'mock-fast', ...hello, max_tokens: 5, max_completion_tokens: 5 },
      'max_completion_tokens',
      /not both/,
    ],
  ];

  it.each(cases)('rejects %s with an OpenAI-style 400', async (_name, payload, param, message) => {
    const { post } = setup();
    const res = await post(payload, { sleeps: 0 });
    expect(res.statusCode).toBe(400);
    const { error } = res.json<{
      error: { type: string; code: string; param: string | null; message: string };
    }>();
    expect(error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_request', param });
    expect(error.message).toMatch(message);
    expect(res.headers['x-should-retry']).toBe('false');
  });

  it('rejects bodies over 1 MiB with 413 before parsing', async () => {
    const { post } = setup();
    const huge = {
      model: 'mock-fast',
      messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
    };
    const res = await post(huge, { sleeps: 0 });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
  });
});

interface Chunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

function chunksOf(body: string): { chunks: Chunk[]; tail: string | undefined } {
  const events = sseData(body);
  const tail = events.at(-1);
  const chunks = (tail === '[DONE]' ? events.slice(0, -1) : events).map(
    (e) => JSON.parse(e) as Chunk,
  );
  return { chunks, tail };
}

describe('POST /v1/chat/completions (streaming)', () => {
  it('streams OpenAI chunks: role first, then content, then finish_reason, then [DONE]', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-stream', ...hello, stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');

    const { chunks, tail } = chunksOf(res.body);
    expect(tail).toBe('[DONE]');
    const id = `chatcmpl-${res.headers['x-request-id'] as string}`;
    for (const chunk of chunks) {
      expect(chunk).toMatchObject({ id, object: 'chat.completion.chunk', model: 'mock-stream' });
      expect(chunk).not.toHaveProperty('usage');
    }
    expect(chunks[0]?.choices).toEqual([
      { index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null },
    ]);
    const text = chunks
      .slice(1, -1)
      .map((c) => c.choices[0]?.delta.content)
      .join('');
    expect(text).toBe('This is a');
    expect(chunks.at(-1)?.choices).toEqual([
      { index: 0, delta: {}, logprobs: null, finish_reason: 'stop' },
    ]);
  });

  it('adds a final usage chunk when stream_options.include_usage is set', async () => {
    const { post } = setup();
    const res = await post({
      model: 'mock-stream',
      ...hello,
      stream: true,
      stream_options: { include_usage: true },
    });
    const { chunks, tail } = chunksOf(res.body);
    expect(tail).toBe('[DONE]');
    const last = chunks.at(-1);
    expect(last?.choices).toEqual([]);
    expect(last?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });
    for (const chunk of chunks.slice(0, -1)) expect(chunk.usage).toBeNull();
  });

  it('returns a JSON 504, not a stream, when the first token misses the timeout', async () => {
    const { post } = setup();
    const res = await post(
      { model: 'mock-stream-ttft', ...hello, stream: true },
      { advance: 1_000 },
    );
    expect(res.statusCode).toBe(504);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
  });

  it('returns a JSON 429 when the upstream rate-limits before the first token', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-limited', ...hello, stream: true });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { code: 'upstream_rate_limited' } });
  });

  it('ends a stream that goes quiet with an error event and no [DONE]', async () => {
    const { app, clock, registry, authorization } = setup();
    const pending = Promise.resolve(
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization },
        payload: { model: 'mock-stream-idle', ...hello, stream: true },
      }),
    );
    await sleepsQueued(clock, 2);
    await clock.advance(0); // first token
    await sleepsQueued(clock, 2);
    await clock.advance(500); // idle timeout fires before the next token at 1000 ms
    const res = await pending;

    expect(res.statusCode).toBe(200);
    const { chunks, tail } = chunksOf(res.body);
    expect(tail).not.toBe('[DONE]');
    expect(chunks.at(-1)).toEqual({
      error: {
        message: 'The model provider did not respond in time.',
        type: 'server_error',
        param: null,
        code: 'upstream_timeout',
      },
    });
    const mock = registry.deployment('stream-idle')?.provider as MockProvider;
    expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 });
  });

  it('reports a mid-stream provider drop as an error event after the tokens already sent', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-stream-drop', ...hello, stream: true });
    const { chunks, tail } = chunksOf(res.body);
    expect(tail).not.toBe('[DONE]');
    const content = chunks.slice(1, -1).map((c) => c.choices[0]?.delta.content);
    expect(content).toEqual(['This', ' is']);
    expect(chunks.at(-1)).toMatchObject({ error: { code: 'upstream_unavailable' } });
  });
});
