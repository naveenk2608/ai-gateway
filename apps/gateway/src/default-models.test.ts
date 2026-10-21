import { fileURLToPath } from 'node:url';
import { systemClock } from '@ai-gateway/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  testAdmission,
  testRouting,
} from '../test/helpers.js';
import { buildApp } from './app.js';
import { SEED_PRICES } from './cli/seed-prices.js';
import { modelRoute, readModelsConfig } from './models-config.js';
import { createRegistry } from './providers/registry.js';
import { registerChatCompletions } from './proxy/chat-completions.js';

/** The models file the gateway ships with (config/models.json). */
const config = readModelsConfig(fileURLToPath(new URL('../config/models.json', import.meta.url)));

/** Placeholders for the tests; never real keys. */
const KEYS = { GROQ_API_KEY: 'groq-test-placeholder', GEMINI_API_KEY: 'gemini-test-placeholder' };

function registry(env: Record<string, string>) {
  const { logger } = captureLogger();
  return createRegistry(config, {
    clock: systemClock,
    logger,
    env,
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
}

describe('the default models file', () => {
  it('has Groq and Gemini deployments on the OpenAI-compatible provider, keyed by env vars', () => {
    expect(config.deployments['groq-gpt-oss-20b']).toMatchObject({
      provider: 'openai-compatible',
      model: 'openai/gpt-oss-20b',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyEnv: 'GROQ_API_KEY',
    });
    expect(config.deployments['gemini-3.5-flash-lite']).toMatchObject({
      provider: 'openai-compatible',
      model: 'gemini-3.5-flash-lite',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnv: 'GEMINI_API_KEY',
    });
  });

  it('routes chat-default by priority: Groq, then Gemini, then the mock', () => {
    const route = modelRoute(config.models['chat-default']!);
    expect(route.policy).toBe('priority');
    expect(route.targets.map((t) => t.deployment)).toEqual([
      'groq-gpt-oss-20b',
      'gemini-3.5-flash-lite',
      'mock',
    ]);
  });

  it('keeps every hosted deployment disabled without its key; chat-default falls back to the mock', async () => {
    const models = registry({});
    expect(models.route('chat-default')?.targets.map((t) => t.deployment.id)).toEqual(['mock']);
    expect(models.route('gpt-oss-20b')).toBeUndefined();
    expect(models.route('gemini-3.5-flash-lite')).toBeUndefined();
    expect(models.route('gpt-4o-mini')).toBeUndefined();
    await models.close();
  });

  it('puts each provider in chat-default once its key is set', async () => {
    const onlyGemini = registry({ GEMINI_API_KEY: KEYS.GEMINI_API_KEY });
    expect(onlyGemini.route('chat-default')?.targets.map((t) => t.deployment.id)).toEqual([
      'gemini-3.5-flash-lite',
      'mock',
    ]);
    await onlyGemini.close();

    const both = registry(KEYS);
    expect(both.route('chat-default')?.targets.map((t) => t.deployment.id)).toEqual([
      'groq-gpt-oss-20b',
      'gemini-3.5-flash-lite',
      'mock',
    ]);
    expect(both.route('gpt-oss-20b')?.targets[0]?.deployment.providerModel).toBe(
      'openai/gpt-oss-20b',
    );
    await both.close();
  });

  // The shipped mock deployment takes about a second of real time to answer.
  it(
    'answers chat-default from the mock when no provider key is set',
    { timeout: 15_000 },
    async () => {
      const { logger } = captureLogger();
      const models = registry({});
      const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
      const { verifier, authorization } = inMemoryVerifier();
      const events = new RecordingBus();
      registerChatCompletions(app, {
        registry: models,
        clock: systemClock,
        verifier,
        events,
        admission: testAdmission(systemClock, logger),
        routing: testRouting(models, systemClock),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization },
        payload: { model: 'chat-default', messages: [{ role: 'user', content: 'hello' }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ choices: unknown[] }>().choices).toHaveLength(1);
      await vi.waitFor(() => expect(events.events).toHaveLength(1));
      const [event] = events.events;
      expect(event?.request).toMatchObject({ model: 'chat-default', deployment: 'mock' });
      expect(event?.attempts.map((a) => a.deployment)).toEqual(['mock']);
      await app.close();
      await models.close();
    },
  );

  it('has a seed price for every Groq and Gemini deployment, keyed like cost rows', () => {
    for (const id of ['groq-gpt-oss-20b', 'gemini-3.5-flash-lite']) {
      const deployment = config.deployments[id]!;
      const price = SEED_PRICES.find(
        (p) => p.provider === deployment.provider && p.model === deployment.model,
      );
      expect(price, id).toBeDefined();
      expect(price!.input_micro_usd_per_mtok).toBeGreaterThan(0);
      expect(price!.output_micro_usd_per_mtok).toBeGreaterThan(0);
    }
  });
});
