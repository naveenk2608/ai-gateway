import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gatewayConfigSchema } from '../src/config.js';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { openAIStream, sendJson, startFakeUpstream, type FakeUpstream } from './fake-upstream.js';
import { captureLogger, sseData } from './helpers.js';

/** The gateway calling an OpenAI-compatible upstream over real HTTP (undici, ADR 004). */
let upstream: FakeUpstream;
let gateway: Gateway;
let baseUrl: string;
let behaviour: 'normal' | 'trickle' | 'unauthorized' | 'silent' = 'normal';

beforeAll(async () => {
  upstream = await startFakeUpstream((req, res) => {
    const body = JSON.parse(req.body) as { stream?: boolean };
    if (behaviour === 'unauthorized') {
      sendJson(res, 401, { error: { message: 'Incorrect API key', code: 'invalid_api_key' } });
    } else if (behaviour === 'silent') {
      // Never answers; the gateway's timeout must give up and hang up.
    } else if (behaviour === 'trickle') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })}\n\n`,
        );
      }, 20);
      res.on('close', () => clearInterval(timer));
    } else if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(openAIStream(['Hello', ' from', ' upstream']));
    } else {
      sendJson(res, 200, {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      });
    }
  });

  const models = parseModelsConfig(
    {
      deployments: {
        hosted: {
          provider: 'openai-compatible',
          model: 'upstream-model-v2',
          baseUrl: `${upstream.url}/v1`,
          apiKeyEnv: 'TEST_UPSTREAM_KEY',
          timeoutMs: 500,
        },
      },
      models: { 'hosted-model': { deployment: 'hosted' } },
    },
    'hosted-test',
  );
  const config = parseConfig(gatewayConfigSchema, {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    PORT: '0',
  });
  gateway = createGateway(config, captureLogger().logger, {
    models,
    env: { TEST_UPSTREAM_KEY: 'test-key-not-secret' },
  });
  await gateway.start();
  const { port } = gateway.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gateway.shutdown();
  await upstream.close();
});

function chat(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'hosted-model',
      messages: [{ role: 'user', content: 'Hi' }],
      ...body,
    }),
  });
}

describe('gateway with an OpenAI-compatible upstream', () => {
  it('forwards a completion using the provider model name and the configured key', async () => {
    behaviour = 'normal';
    const res = await chat({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      choices: { message: { content: string } }[];
    };
    expect(body.model).toBe('hosted-model');
    expect(body.choices[0]?.message.content).toBe('Hi!');

    const sent = upstream.requests.at(-1)!;
    expect(JSON.parse(sent.body)).toMatchObject({ model: 'upstream-model-v2' });
    expect(sent.headers.authorization).toBe('Bearer test-key-not-secret');
  });

  it('relays a stream with its usage chunk', async () => {
    behaviour = 'normal';
    const res = await chat({ stream: true, stream_options: { include_usage: true } });
    const events = sseData(await res.text());
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map(
      (e) =>
        JSON.parse(e) as {
          choices: { delta: { content?: string } }[];
          usage: { completion_tokens: number } | null;
        },
    );
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe(
      'Hello from upstream',
    );
    expect(chunks.at(-1)?.usage?.completion_tokens).toBe(3);
  });

  it('hangs up on the upstream when the client disconnects mid-stream', async () => {
    behaviour = 'trickle';
    const before = upstream.closedEarly;
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        `${baseUrl}/v1/chat/completions`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.end(
        JSON.stringify({
          model: 'hosted-model',
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      );
    });
    await vi.waitFor(() => expect(upstream.closedEarly).toBe(before + 1));
  });

  it('maps an upstream 401 to 502 upstream_auth_failed without leaking the upstream message', async () => {
    behaviour = 'unauthorized';
    const res = await chat({});
    expect(res.status).toBe(502);
    expect(res.headers.get('x-should-retry')).toBe('false');
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'upstream_auth_failed' } });
    expect(text).not.toContain('Incorrect API key');
  });

  it('times out a silent upstream with 504 and closes that connection', async () => {
    behaviour = 'silent';
    const before = upstream.closedEarly;
    const res = await chat({});
    expect(res.status).toBe(504);
    await vi.waitFor(() => expect(upstream.closedEarly).toBe(before + 1));
  });
});
