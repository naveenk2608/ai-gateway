import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { sendJson, startFakeUpstream, type FakeUpstream } from './fake-upstream.js';
import { captureLogger, testConfig, type LogLine } from './helpers.js';

/**
 * ADR 026: a provider that lists a model but answers every chat call for it with 404, as NVIDIA
 * did for Nemotron 3 Super in M11. Its `GET /models` passes, so a `models` health check half-opens
 * the breaker each time; a `chat` health check fails and keeps it open.
 */
let upstream: FakeUpstream;
let gateway: Gateway;
let lines: LogLine[];
let authorization: string;
let baseUrl: string;

beforeAll(async () => {
  upstream = await startFakeUpstream((req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { object: 'list', data: [{ id: 'listed-model', object: 'model' }] });
    } else {
      sendJson(res, 404, { status: 404, title: 'Not Found', detail: 'Not found for account' });
    }
  });
  const deployment = (path: string, healthCheck: 'chat' | 'models') => ({
    provider: 'openai-compatible',
    model: 'listed-model',
    // A path per deployment, so the upstream can tell their calls apart.
    baseUrl: `${upstream.url}/${path}/v1`,
    apiKeyEnv: 'TEST_UPSTREAM_KEY',
    healthCheck,
    timeoutMs: 1_000,
  });
  const models = parseModelsConfig(
    {
      deployments: {
        'listed-chat': deployment('chat', 'chat'),
        'listed-models': deployment('models', 'models'),
      },
      models: {
        'checked-by-chat': { deployment: 'listed-chat' },
        'checked-by-models': { deployment: 'listed-models' },
      },
    },
    'chat-health-check',
  );
  const captured = captureLogger();
  lines = captured.lines;
  gateway = createGateway(
    testConfig({
      // The first failure opens the breaker; checks run every 100 ms, a chat check every 200 ms.
      BREAKER_FAILURE_THRESHOLD: '1',
      BREAKER_OPEN_MS: '300',
      HEALTH_CHECK_INTERVAL_MS: '100',
      HEALTH_CHECK_TIMEOUT_MS: '1000',
      HEALTH_CHECK_CHAT_INTERVAL_MS: '200',
    }),
    captured.logger,
    { models, env: { TEST_UPSTREAM_KEY: 'test-key-not-secret' } },
  );
  await gateway.start();
  const key = await createApiKey(gateway.db, await createProject(gateway.db));
  authorization = `Bearer ${key.plaintext}`;
  baseUrl = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.shutdown();
  await upstream.close();
});

async function chat(model: string) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }] }),
  });
  return { status: res.status, body: (await res.json()) as { error?: { code: string } } };
}

const transitions = (deployment: string) =>
  lines
    .filter((l) => l.msg === 'circuit breaker state changed' && l.deployment === deployment)
    .map((l) => `${String(l.from)}->${String(l.to)}: ${String(l.reason)}`);

const calls = (path: string, method: string) =>
  upstream.requests.filter((r) => r.url.startsWith(`/${path}/`) && r.method === method);

describe('chat health checks', () => {
  it('keep the breaker of a listed but unserved model open, where a models check reopens it', async () => {
    for (const model of ['checked-by-chat', 'checked-by-models']) {
      const res = await chat(model);
      expect(res.status).toBe(502);
      expect(res.body.error?.code).toBe('upstream_model_not_found');
    }

    // Several open periods (300 ms) and chat check intervals (200 ms) pass.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // The chat check failed each time, so the breaker never half-opened.
    expect(gateway.breakers.get('listed-chat').state).toBe('open');
    expect(transitions('listed-chat')).toEqual([
      'closed->open: 1 consecutive failures (last: not_found)',
    ]);
    const probes = calls('chat', 'POST').slice(1);
    expect(probes.length).toBeGreaterThanOrEqual(2);
    for (const probe of probes) {
      expect(JSON.parse(probe.body)).toMatchObject({ model: 'listed-model', max_tokens: 1 });
    }
    expect(calls('chat', 'GET')).toHaveLength(0);

    // The models check passed against the same upstream and half-opened the other breaker.
    expect(calls('models', 'GET').length).toBeGreaterThanOrEqual(1);
    expect(transitions('listed-models')).toContain('open->half_open: health check passed');
  });
});
