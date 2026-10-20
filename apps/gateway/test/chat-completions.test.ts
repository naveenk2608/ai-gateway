import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gatewayConfigSchema } from '../src/config.js';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { captureLogger } from './helpers.js';

/** Real timings, kept small; timeout cases use wide margins so they cannot flake. */
const models = parseModelsConfig(
  {
    deployments: {
      quick: { provider: 'mock', mock: { latencyMs: 20, completionTokens: 6 } },
      stuck: { provider: 'mock', timeoutMs: 300, mock: { latencyMs: 60_000, ttftMs: 60_000 } },
      hanging: { provider: 'mock', mock: { latencyMs: 60_000 } },
    },
    models: {
      'mock-quick': { deployment: 'quick' },
      'mock-stuck': { deployment: 'stuck' },
      'mock-hanging': { deployment: 'hanging' },
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
