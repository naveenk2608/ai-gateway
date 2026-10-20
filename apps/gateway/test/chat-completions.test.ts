import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gatewayConfigSchema } from '../src/config.js';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { captureLogger, sseData } from './helpers.js';

/** Real timings, kept small; timeout cases use wide margins so they cannot flake. */
const models = parseModelsConfig(
  {
    deployments: {
      quick: { provider: 'mock', mock: { latencyMs: 20, completionTokens: 6 } },
      stuck: { provider: 'mock', timeoutMs: 300, mock: { latencyMs: 60_000, ttftMs: 60_000 } },
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
      'mock-hanging': { deployment: 'hanging' },
      'mock-streamer': { deployment: 'streamer' },
      'mock-endless': { deployment: 'endless' },
      'mock-steady': { deployment: 'steady' },
    },
  },
  'integration',
);

let gateway: Gateway;
let baseUrl: string;

beforeAll(async () => {
  const config = parseConfig(gatewayConfigSchema, {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    PORT: '0',
  });
  gateway = createGateway(config, captureLogger().logger, { models });
  await gateway.start();
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
    headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: '{"model":',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('times out with 504 and cancels the upstream call', async () => {
    const started = Date.now();
    const res = await chat({ model: 'mock-stuck', ...hello });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(mockFor('stuck').stats()).toMatchObject({ canceled: 1, active: 0 });
  });

  it('cancels the upstream call when the client disconnects before the response', async () => {
    const mock = mockFor('hanging');
    const req = httpRequest(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

  it('closing the client socket mid-stream cancels the upstream request', async () => {
    const mock = mockFor('endless');
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `${baseUrl}/v1/chat/completions`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
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
    const config = parseConfig(gatewayConfigSchema, {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
      PORT: '0',
      SHUTDOWN_TIMEOUT_MS: '20000',
    });
    const own = createGateway(config, captureLogger().logger, { models });
    await own.start();
    const { port } = own.app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
