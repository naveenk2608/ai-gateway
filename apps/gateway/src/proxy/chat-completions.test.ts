import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger, sleepsQueued } from '../../test/helpers.js';
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
      },
    },
    'test',
  );
  const registry = createRegistry(models, { clock, logger });
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  registerChatCompletions(app, { registry, clock });

  /** Sends a request, then advances the manual clock once its sleeps are queued. */
  async function post(payload: unknown, { sleeps = 2, advance = 0 } = {}) {
    const pending = Promise.resolve(
      app.inject({ method: 'POST', url: '/v1/chat/completions', payload: payload as object }),
    );
    if (sleeps > 0) {
      await sleepsQueued(clock, sleeps);
      await clock.advance(advance);
    }
    return pending;
  }
  return { app, clock, registry, lines, post };
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
