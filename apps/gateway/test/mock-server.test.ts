/**
 * M9: the gateway reaching the HTTP mock provider through its OpenAI-compatible adapter, the path
 * the benchmarks measure, with usage reported by the mock stored once per request.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { systemClock } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { startMockServer, type MockServer } from '../src/mock-server/server.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

const tag = randomBytes(3).toString('hex');

let mock: MockServer;
let gateway: Gateway;
let projectId: string;
let authorization: string;
let url: string;

beforeAll(async () => {
  mock = await startMockServer({
    settings: {
      latencyMs: 0,
      ttftMs: 0,
      completionTokens: 6,
      errorRate: 0,
      seed: 1,
      retryAfterMs: 1_000,
    },
    clock: systemClock,
    host: '127.0.0.1',
    port: 0,
  });
  const models = parseModelsConfig(
    {
      deployments: {
        [`http-mock-${tag}`]: {
          provider: 'openai-compatible',
          model: 'bench-model',
          baseUrl: `${mock.url}/v1`,
          apiKeyEnv: 'MOCK_API_KEY',
        },
      },
      models: { 'bench-1': { deployment: `http-mock-${tag}` } },
    },
    'mock-server-test',
  );
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:mock-http:${tag}`,
      EVENTS_DLQ_STREAM: `test:mock-http:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `mock-http-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models, env: { MOCK_API_KEY: 'bench-not-a-secret' } },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  projectId = await createProject(gateway.db);
  authorization = `Bearer ${(await createApiKey(gateway.db, projectId)).plaintext}`;
});

afterAll(async () => {
  await gateway.shutdown();
  await mock.close();
});

function chat(body: Record<string, unknown>) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({
      model: 'bench-1',
      messages: [{ role: 'user', content: 'Hi' }],
      ...body,
    }),
  });
}

describe('gateway with the HTTP mock provider', () => {
  it('relays completions and streams, and stores the usage the mock reported once each', async () => {
    const plain = await chat({});
    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({
      model: 'bench-1',
      choices: [{ message: { content: 'This is a deterministic response from' } }],
      usage: { completion_tokens: 6 },
    });

    const streamed = await chat({ stream: true, stream_options: { include_usage: true } });
    expect(streamed.status).toBe(200);
    const events = sseData(await streamed.text());
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events
      .slice(0, -1)
      .map((e) => JSON.parse(e) as { choices: { delta: { content?: string } }[] });
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe(
      'This is a deterministic response from',
    );
    expect(mock.provider.stats()).toMatchObject({ requests: 2, completed: 2 });

    await vi.waitFor(
      async () => {
        const rows = await gateway.db
          .selectFrom('usage_events')
          .select(['request_id', 'completion_tokens', 'usage_source'])
          .where('project_id', '=', projectId)
          .execute();
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.request_id)).size).toBe(2);
        for (const row of rows) {
          expect(row).toMatchObject({ completion_tokens: 6, usage_source: 'reported' });
        }
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});
