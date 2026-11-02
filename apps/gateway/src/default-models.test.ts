import { readFileSync } from 'node:fs';
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
import { modelRoute, readModelsConfig } from './models-config.js';
import { createRegistry } from './providers/registry.js';
import { registerChatCompletions } from './proxy/chat-completions.js';

/** The models file the gateway ships with (config/models.json). */
const config = readModelsConfig(fileURLToPath(new URL('../config/models.json', import.meta.url)));

/** Placeholders for the tests; never real keys or account IDs. */
const KEYS = {
  GROQ_API_KEY: 'groq-test-placeholder',
  GEMINI_API_KEY: 'gemini-test-placeholder',
  MISTRAL_API_KEY: 'mistral-test-placeholder',
  NVIDIA_API_KEY: 'nvidia-test-placeholder',
  OPENROUTER_API_KEY: 'openrouter-test-placeholder',
  CLOUDFLARE_API_TOKEN: 'cloudflare-test-placeholder',
  CLOUDFLARE_ACCOUNT_ID: 'account-test-placeholder',
  ZAI_API_KEY: 'zai-test-placeholder',
};

/** The list prices migration 0006 inserts. */
const MIGRATION_PRICES = [
  ...readFileSync(
    fileURLToPath(new URL('../../../db/migrations/0006_provider-prices.sql', import.meta.url)),
    'utf8',
  ).matchAll(/\(gen_random_uuid\(\), '([^']+)', '([^']+)', (\d+), (\d+), '([^']+)'\)/g),
].map(([, provider, model, input, output]) => ({
  provider: provider!,
  model: model!,
  input: Number(input),
  output: Number(output),
}));

/** The reference prices migration 0009 inserts: paid models no deployment may call. */
const REFERENCE_PRICES = [
  ...readFileSync(
    fileURLToPath(new URL('../../../db/migrations/0009_reference-prices.sql', import.meta.url)),
    'utf8',
  ).matchAll(/\(gen_random_uuid\(\), '([^']+)', '([^']+)', (\d+), (\d+), '[^']+', true\)/g),
].map(([, provider, model]) => ({ provider: provider!, model: model! }));

function registry(env: Record<string, string>) {
  const { logger } = captureLogger();
  return createRegistry(config, {
    clock: systemClock,
    logger,
    env,
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
}

const hosted = Object.entries(config.deployments).flatMap(([id, d]) =>
  d.adapter === 'openai-compatible' ? [[id, d] as const] : [],
);
const targetsOf = (models: ReturnType<typeof registry>, name: string) =>
  models.route(name)?.targets.map((t) => t.deployment.id);

describe('the default models file', () => {
  it('names the provider of every hosted deployment and reads its key from the environment', () => {
    const keyOf = new Map([
      ['groq', 'GROQ_API_KEY'],
      ['gemini', 'GEMINI_API_KEY'],
      ['mistral', 'MISTRAL_API_KEY'],
      ['nvidia', 'NVIDIA_API_KEY'],
      ['openrouter', 'OPENROUTER_API_KEY'],
      ['cloudflare', 'CLOUDFLARE_API_TOKEN'],
      ['zai', 'ZAI_API_KEY'],
    ]);
    expect(hosted.length).toBeGreaterThanOrEqual(13);
    for (const [id, d] of hosted) {
      expect(keyOf.get(d.provider), id).toBe(d.apiKeyEnv);
      expect(id.startsWith(d.provider), id).toBe(true);
    }
    expect(config.deployments['groq-gpt-oss-120b']).toMatchObject({
      adapter: 'openai-compatible',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    // Cloudflare's account ID comes from the environment, never the file.
    expect(config.deployments['cloudflare-llama-4-scout']).toMatchObject({
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
      healthCheck: 'none',
    });
    expect(config.deployments.mock).toMatchObject({ adapter: 'mock', provider: 'mock' });
    expect(config.deployments['ollama-llama3.2']).toMatchObject({ provider: 'ollama' });
  });

  it('sets the published free-tier quotas (docs/providers.md) and no others', () => {
    const quotas = Object.fromEntries(
      Object.entries(config.deployments).flatMap(([id, d]) => (d.quota ? [[id, d.quota]] : [])),
    );
    const groq = {
      requestsPerMinute: 30,
      requestsPerDay: 1_000,
      tokensPerMinute: 8_000,
      tokensPerDay: 200_000,
    };
    expect(quotas).toEqual({
      'groq-gpt-oss-20b': groq,
      'groq-gpt-oss-120b': groq,
      'groq-qwen3.8-27b': groq,
      // Per account, not per model: OpenRouter has one :free deployment here.
      'openrouter-gemma-4-31b-free': { requestsPerMinute: 20, requestsPerDay: 50 },
      // 10,000 free Neurons a day at 77,273 Neurons per million output tokens.
      'cloudflare-llama-4-scout': { requestsPerMinute: 300, tokensPerDay: 129_000 },
    });
  });

  it('only uses OpenRouter models whose id ends in :free', () => {
    const openrouter = hosted.filter(([, d]) => d.provider === 'openrouter');
    expect(openrouter.length).toBeGreaterThan(0);
    for (const [id, d] of openrouter) expect(d.model, id).toMatch(/:free$/);
  });

  it('routes chat-default by priority over the real providers, with the mock last', () => {
    const route = modelRoute(config.models['chat-default']!);
    expect(route.policy).toBe('priority');
    const ids = route.targets.map((t) => t.deployment);
    expect(ids.slice(0, 2)).toEqual(['groq-gpt-oss-20b', 'gemini-3.5-flash-lite']);
    expect(ids.at(-1)).toBe('mock');
    expect(new Set(ids.map((id) => config.deployments[id]!.provider)).size).toBeGreaterThan(5);
  });

  it('has chat-fast, chat-cheap and chat-variety, each with the mock as its only last resort', () => {
    for (const [name, policy] of [
      ['chat-fast', 'lowest_latency'],
      ['chat-cheap', 'cost_aware'],
      ['chat-variety', 'weighted'],
    ] as const) {
      const route = modelRoute(config.models[name]!);
      expect(route.policy, name).toBe(policy);
      expect(route.targets.at(-1), name).toMatchObject({ deployment: 'mock', lastResort: true });
      expect(
        route.targets.filter((t) => t.lastResort),
        name,
      ).toHaveLength(1);
    }
  });

  it('runs everything on the mock when no provider key is set', async () => {
    const models = registry({});
    for (const name of ['chat-default', 'chat-fast', 'chat-cheap', 'chat-variety']) {
      expect(targetsOf(models, name), name).toEqual(['mock']);
    }
    for (const [id] of hosted) expect(models.deployment(id), id).toBeUndefined();
    expect(models.route('gpt-oss-20b')).toBeUndefined();
    expect(models.route('glm-4.7-flash')).toBeUndefined();
    await models.close();
  });

  it('keeps chat-default as it was before M11 with only the Groq and Gemini keys', async () => {
    const onlyGemini = registry({ GEMINI_API_KEY: KEYS.GEMINI_API_KEY });
    expect(targetsOf(onlyGemini, 'chat-default')).toEqual(['gemini-3.5-flash-lite', 'mock']);
    await onlyGemini.close();

    const both = registry({ GROQ_API_KEY: KEYS.GROQ_API_KEY, GEMINI_API_KEY: KEYS.GEMINI_API_KEY });
    expect(targetsOf(both, 'chat-default')).toEqual([
      'groq-gpt-oss-20b',
      'gemini-3.5-flash-lite',
      'mock',
    ]);
    expect(both.route('gpt-oss-20b')?.targets[0]?.deployment.providerModel).toBe(
      'openai/gpt-oss-20b',
    );
    // Qwen uses the Groq key too, but is a preview model and stays out of chat-default.
    expect(both.route('qwen3')?.targets[0]?.deployment.providerModel).toBe('qwen/qwen3.8-27b');
    await both.close();
  });

  it('enables every provider once its key is set, and Cloudflare only with its account ID', async () => {
    const all = registry(KEYS);
    for (const [id] of hosted) expect(all.deployment(id), id).toBeDefined();
    expect(all.deployment('cloudflare-llama-4-scout')).toMatchObject({
      providerName: 'cloudflare',
      baseUrlHost: 'api.cloudflare.com',
      probes: false,
    });
    expect(all.deployment('groq-gpt-oss-20b')).toMatchObject({
      providerName: 'groq',
      adapter: 'openai-compatible',
      baseUrlHost: 'api.groq.com',
      probes: true,
    });
    await all.close();

    const withoutAccount: Record<string, string> = { ...KEYS };
    delete withoutAccount.CLOUDFLARE_ACCOUNT_ID;
    const noAccount = registry(withoutAccount);
    expect(noAccount.deployment('cloudflare-llama-4-scout')).toBeUndefined();
    expect(noAccount.deployment('zai-glm-4.7-flash')).toBeDefined();
    await noAccount.close();
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
      expect(event?.attempts.map((a) => [a.deployment, a.provider, a.adapter])).toEqual([
        ['mock', 'mock', 'mock'],
      ]);
      await app.close();
      await models.close();
    },
  );

  it('has a list price for every hosted deployment, keyed by provider name and model', () => {
    for (const [id, d] of hosted) {
      const price = MIGRATION_PRICES.find((p) => p.provider === d.provider && p.model === d.model);
      expect(price, id).toBeDefined();
      expect(price!.input, id).toBeGreaterThan(0);
      expect(price!.output, id).toBeGreaterThan(0);
    }
    // No price is keyed by an adapter kind any more.
    expect(MIGRATION_PRICES.filter((p) => p.provider === 'openai-compatible')).toEqual([]);
  });

  it('serves no model that has only a reference price, so none is ever routed', () => {
    expect(REFERENCE_PRICES.length).toBeGreaterThanOrEqual(3);
    for (const ref of REFERENCE_PRICES) {
      const serving = Object.entries(config.deployments).filter(
        ([, d]) => d.provider === ref.provider && d.model === ref.model,
      );
      expect(serving, `${ref.provider} ${ref.model}`).toEqual([]);
    }
  });
});
