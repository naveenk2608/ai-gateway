import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

/** Real timings, kept small; timeout cases use wide margins so they cannot flake. */
const models = parseModelsConfig(
  {
    deployments: {
      quick: { provider: 'mock', mock: { latencyMs: 20, completionTokens: 6 } },
      stuck: { provider: 'mock', timeoutMs: 300, mock: { latencyMs: 60_000, ttftMs: 60_000 } },
      'stuck-stream': {
        provider: 'mock',
        timeoutMs: 300,
        mock: { latencyMs: 60_000, ttftMs: 60_000 },
      },
      hanging: { provider: 'mock', mock: { latencyMs: 60_000 } },
      streamer: {
        provider: 'mock',
        mock: { ttftMs: 20, tokensPerSecond: 200, completionTokens: 12 },
      },
      endless: { provider: 'mock', mock: { tokensPerSecond: 20, completionTokens: 2_000 } },
      steady: { provider: 'mock', mock: { tokensPerSecond: 20, completionTokens: 20 } },
    },
    models: {
      'mock-quick': { deployment: 'quick' },
      'mock-stuck': { deployment: 'stuck' },
      'mock-stuck-stream': { deployment: 'stuck-stream' },
      'mock-hanging': { deployment: 'hanging' },
      'mock-streamer': { deployment: 'streamer' },
      'mock-endless': { deployment: 'endless' },
      'mock-steady': { deployment: 'steady' },
    },
  },
  'integration',
);

let gateway: Gateway;
let authorization: string;
let baseUrl: string;

beforeAll(async () => {
  const config = testConfig();
  gateway = createGateway(config, captureLogger().logger, { models });
  await gateway.start();
  const key = await createApiKey(gateway.db, await createProject(gateway.db));
  authorization = `Bearer ${key.plaintext}`;
  const { port } = gateway.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gateway.shutdown();
});

function mockFor(deployment: string): MockProvider {
  return gateway.registry.deployment(deployment)?.provider as MockProvider;
}

function chat(body: unknown) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify(body),
  });
}

const hello = { messages: [{ role: 'user', content: 'Say hello' }] };

describe('chat completions over HTTP against the mock (non-streaming)', () => {
  it('returns an OpenAI chat.completion', async () => {
    const res = await chat({ model: 'mock-quick', ...hello });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await res.json()) as {
      object: string;
      model: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { completion_tokens: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('mock-quick');
    expect(body.choices[0]?.message.content).toBe('This is a deterministic response from');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage.completion_tokens).toBe(6);
  });

  it('rejects an invalid payload with 400', async () => {
    const res = await chat({ model: 'mock-quick', messages: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'invalid_request', param: 'messages' },
    });
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: '{"model":',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('times out with 504 and cancels each upstream call, including the retry', async () => {
    const started = Date.now();
    const res = await chat({ model: 'mock-stuck', ...hello });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
    expect(Date.now() - started).toBeLessThan(10_000);
    // A timeout is retryable (ADR 011): one retry on the only deployment, both cancelled.
    expect(mockFor('stuck').stats()).toMatchObject({ requests: 2, canceled: 2, active: 0 });
  });

  it('cancels the upstream call when the client disconnects before the response', async () => {
    const mock = mockFor('hanging');
    const req = httpRequest(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
    });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ model: 'mock-hanging', ...hello }));

    await vi.waitFor(() => expect(mock.stats().active).toBe(1));
    req.destroy();
    await vi.waitFor(() => expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 }));
  });
});

describe('chat completions over HTTP against the mock (streaming)', () => {
  it('streams SSE chunks ending with data: [DONE]', async () => {
    const res = await chat({ model: 'mock-streamer', ...hello, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    const events = sseData(await res.text());
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map(
      (e) =>
        JSON.parse(e) as {
          object: string;
          choices: { delta: { content?: string }; finish_reason: string | null }[];
        },
    );
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(text).toBe('This is a deterministic response from the mock provider. This is a');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });

  it('answers a stream whose first event never comes with a 504 JSON error, cancelling each try', async () => {
    const started = Date.now();
    const res = await chat({ model: 'mock-stuck-stream', ...hello, stream: true });
    // Nothing was sent before the first event, so the failure is a normal HTTP error (ADR 011).
    expect(res.status).toBe(504);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(mockFor('stuck-stream').stats()).toMatchObject({ requests: 2, canceled: 2, active: 0 });
  });

  it('closing the client socket mid-stream cancels the upstream request', async () => {
    const mock = mockFor('endless');
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${baseUrl}/v1/chat/completions`,
        { method: 'POST', headers: { 'content-type': 'application/json', authorization } },
        (res) => {
          // Hang up as soon as the first bytes of the stream arrive.
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.on('timeout', () => reject(new Error('no stream data')));
      req.end(JSON.stringify({ model: 'mock-endless', ...hello, stream: true }));
    });

    await vi.waitFor(() => expect(mock.stats()).toMatchObject({ canceled: 1, active: 0 }));
    const stats = mock.stats();
    expect(stats.completed).toBe(0);
    // 2000 tokens at 20/s would take 100 s; generation stopped right after the hang-up.
    expect(stats.tokensEmitted).toBeLessThan(10);
  });

  it('lets an in-flight stream finish during shutdown, then closes its socket', async () => {
    const config = testConfig({
      SHUTDOWN_TIMEOUT_MS: '20000',
    });
    const own = createGateway(config, captureLogger().logger, { models });
    await own.start();
    const { port } = own.app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ model: 'mock-steady', ...hello, stream: true }),
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value, { stream: true });

    // The stream (20 tokens at 20/s, about 1 s) is in flight when shutdown starts.
    const started = Date.now();
    const shutdown = own.shutdown();
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      text += decoder.decode(part.value, { stream: true });
    }

    expect(text).toContain('data: [DONE]');
    expect(await shutdown).toBe('drained');
    // Without closing the finished stream's socket, the drain would wait for keep-alive (72 s).
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('a timeout that opens the breaker', () => {
  // With a threshold of 1, the first timeout opens the deployment's breaker, so the retry is
  // skipped and the request fails at once. Gemini 3.8 Flash did this in M11's live checks.
  let own: Gateway;
  let ownUrl: string;

  beforeAll(async () => {
    own = createGateway(testConfig({ BREAKER_FAILURE_THRESHOLD: '1' }), captureLogger().logger, {
      models,
    });
    await own.start();
    const { port } = own.app.server.address() as AddressInfo;
    ownUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await own.shutdown();
  });

  it.each([
    { stream: false, model: 'mock-stuck', deployment: 'stuck' },
    { stream: true, model: 'mock-stuck-stream', deployment: 'stuck-stream' },
  ])(
    'still answers 504 with a JSON error (stream: $stream), without a retry',
    async ({ stream, model, deployment }) => {
      const res = await fetch(`${ownUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ model, ...hello, stream }),
      });
      expect(res.status).toBe(504);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await res.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
      const mock = own.registry.deployment(deployment)?.provider as MockProvider;
      expect(mock.stats()).toMatchObject({ requests: 1, canceled: 1, active: 0 });
    },
  );
});

describe('the request deadline (REQUEST_DEADLINE_MS)', () => {
  // Without the deadline, `slow-long` would answer after 2 tries of 5 s, and `slow-route` after
  // 3 tries of 400 ms each (2 on its first deployment, then the fallback).
  const stuck = { latencyMs: 60_000, ttftMs: 60_000 };
  const deadlineModels = parseModelsConfig(
    {
      deployments: {
        'slow-long': { provider: 'mock', timeoutMs: 5_000, mock: stuck },
        'slow-long-stream': { provider: 'mock', timeoutMs: 5_000, mock: stuck },
        'slow-a': { provider: 'mock', timeoutMs: 400, mock: stuck },
        'slow-b': { provider: 'mock', timeoutMs: 400, mock: stuck },
        'slow-a-stream': { provider: 'mock', timeoutMs: 400, mock: stuck },
        'slow-b-stream': { provider: 'mock', timeoutMs: 400, mock: stuck },
      },
      models: {
        'slow-long': { deployment: 'slow-long' },
        'slow-long-stream': { deployment: 'slow-long-stream' },
        'slow-route': {
          policy: 'priority',
          targets: [{ deployment: 'slow-a' }, { deployment: 'slow-b' }],
        },
        'slow-route-stream': {
          policy: 'priority',
          targets: [{ deployment: 'slow-a-stream' }, { deployment: 'slow-b-stream' }],
        },
      },
    },
    'deadline',
  );
  let own: Gateway;
  let ownUrl: string;

  beforeAll(async () => {
    own = createGateway(testConfig({ REQUEST_DEADLINE_MS: '700' }), captureLogger().logger, {
      models: deadlineModels,
    });
    await own.start();
    const { port } = own.app.server.address() as AddressInfo;
    ownUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await own.shutdown();
  });

  const stats = (deployment: string) =>
    (own.registry.deployment(deployment)?.provider as MockProvider).stats();

  async function timed(model: string, stream: boolean) {
    const started = Date.now();
    const res = await fetch(`${ownUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ model, ...hello, stream }),
    });
    const body = (await res.json()) as { error?: { code: string } };
    return { res, body, ms: Date.now() - started };
  }

  it.each([
    { stream: false, model: 'slow-long' },
    { stream: true, model: 'slow-long-stream' },
  ])('cuts a try that would outlast it (stream: $stream)', async ({ stream, model }) => {
    const { res, body, ms } = await timed(model, stream);
    expect(res.status).toBe(504);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(body.error?.code).toBe('upstream_timeout');
    // At the 700 ms deadline, not after the 5 s timeout, and with no retry after it.
    expect(ms).toBeGreaterThanOrEqual(650);
    expect(ms).toBeLessThan(3_000);
    expect(stats(model)).toMatchObject({ requests: 1, canceled: 1, active: 0 });
  });

  it.each([
    { stream: false, model: 'slow-route', a: 'slow-a', b: 'slow-b' },
    { stream: true, model: 'slow-route-stream', a: 'slow-a-stream', b: 'slow-b-stream' },
  ])('starts no retry or fallback after it (stream: $stream)', async ({ stream, model, a, b }) => {
    const { res, body, ms } = await timed(model, stream);
    expect(res.status).toBe(504);
    expect(body.error?.code).toBe('upstream_timeout');
    expect(ms).toBeLessThan(3_000);
    // The first deployment's try timed out at 400 ms and its retry was cut at 700 ms; the
    // fallback was never tried.
    expect(stats(a)).toMatchObject({ requests: 2, canceled: 2, active: 0 });
    expect(stats(b).requests).toBe(0);
  });
});
