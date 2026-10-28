import { systemClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  testAdmission,
  testRouting,
} from '../../test/helpers.js';
import { buildApp } from '../app.js';
import { parseModelsConfig } from '../models-config.js';
import { createRegistry } from '../providers/registry.js';
import { registerChatCompletions } from './chat-completions.js';
import { registerModels } from './models.js';

const models = parseModelsConfig(
  {
    deployments: {
      fast: { provider: 'mock', mock: { completionTokens: 3 } },
      broken: { provider: 'mock', mock: { failWith: 500 } },
      hosted: {
        provider: 'openai-compatible',
        model: 'x',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'EXAMPLE_API_KEY',
      },
    },
    models: {
      'mock-fast': { deployment: 'fast' },
      'mock-failover': {
        policy: 'priority',
        targets: [{ deployment: 'broken' }, { deployment: 'fast' }],
      },
      // Its only deployment has no key, so it is not available.
      'hosted-x': { deployment: 'hosted' },
    },
  },
  'test',
);

/** The /v1 routes as the gateway assembles them, with retries that move on after one failure. */
function setup(allowedModels: string[] | null = null) {
  const { logger } = captureLogger();
  const registry = createRegistry(models, {
    clock: systemClock,
    logger,
    env: {},
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const { verifier, authorization, record } = inMemoryVerifier();
  (record as { allowedModels: string[] | null }).allowedModels = allowedModels;
  registerChatCompletions(app, {
    registry,
    clock: systemClock,
    verifier,
    events: new RecordingBus(),
    admission: testAdmission(systemClock, logger),
    routing: testRouting(registry, systemClock, { retry: { maxAttempts: 3, perDeployment: 1 } }),
  });
  registerModels(app, { registry, verifier, clock: systemClock });
  const chat = (model: string, stream = false) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization },
      payload: { model, stream, messages: [{ role: 'user', content: 'hi' }] },
    });
  return { app, authorization, chat };
}

describe('GET /v1/models', () => {
  it('needs an API key, like every /v1 route', async () => {
    const res = await setup().app.inject('/v1/models');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_api_key' } });
  });

  it("lists the models with an enabled deployment, in OpenAI's list format", async () => {
    const { app, authorization } = setup();
    const res = await app.inject({ url: '/v1/models', headers: { authorization } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ object: string; data: Record<string, unknown>[] }>();
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['mock-fast', 'mock-failover']);
    expect(body.data[0]).toEqual({
      id: 'mock-fast',
      object: 'model',
      created: expect.any(Number) as number,
      owned_by: 'ai-gateway',
    });
  });

  it("lists only the models the key's project is allowed to use", async () => {
    const { app, authorization } = setup(['mock-failover', 'hosted-x']);
    const res = await app.inject({ url: '/v1/models', headers: { authorization } });
    expect(res.json<{ data: { id: string }[] }>().data.map((m) => m.id)).toEqual(['mock-failover']);
  });
});

describe('routing headers on /v1/chat/completions', () => {
  it('names the deployment that answered', async () => {
    const res = await setup().chat('mock-fast');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-deployment']).toBe('fast');
    expect(res.headers['x-gateway-fallback-from']).toBeUndefined();
  });

  it('names the deployments passed over after a fallback, streamed or not', async () => {
    for (const stream of [false, true]) {
      const res = await setup().chat('mock-failover', stream);
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-gateway-deployment']).toBe('fast');
      expect(res.headers['x-gateway-fallback-from']).toBe('broken');
    }
  });

  it('sends no routing headers when no deployment answered', async () => {
    const res = await setup().chat('no-such-model');
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-gateway-deployment']).toBeUndefined();
  });
});
