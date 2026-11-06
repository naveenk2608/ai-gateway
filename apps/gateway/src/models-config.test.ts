import { fileURLToPath } from 'node:url';
import { ConfigError } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  baseUrlVariables,
  expandBaseUrl,
  modelRoute,
  parseModelsConfig,
  readModelsConfig,
} from './models-config.js';

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return [...err.problems];
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('models config', () => {
  it('applies defaults to a minimal mock deployment', () => {
    const config = parseModelsConfig(
      { deployments: { m: { provider: 'mock' } }, models: { 'mock-1': { deployment: 'm' } } },
      'test',
    );
    expect(config.deployments.m).toEqual({
      adapter: 'mock',
      provider: 'mock',
      model: 'mock',
      billing: 'paid',
      capabilities: { tools: true, json_object: true, json_schema: true, vision: true },
      type: 'chat',
      timeoutMs: 60_000,
      streamIdleTimeoutMs: 30_000,
      maxOutputTokens: 4_096,
      mock: {
        latencyMs: 0,
        ttftMs: 0,
        completionTokens: 16,
        errorRate: 0,
        seed: 1,
        retryAfterMs: 1_000,
      },
    });
  });

  it('reads an adapter kind and a provider name, which defaults to the adapter kind', () => {
    const config = parseModelsConfig(
      {
        deployments: {
          named: {
            adapter: 'openai-compatible',
            provider: 'groq',
            model: 'openai/gpt-oss-20b',
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKeyEnv: 'GROQ_API_KEY',
          },
          unnamed: {
            adapter: 'openai-compatible',
            model: 'm',
            baseUrl: 'http://127.0.0.1:8090/v1',
            apiKeyEnv: 'MOCK_KEY',
            healthCheck: 'none',
          },
          // A file from before provider names: `provider` holds the adapter kind.
          legacy: { provider: 'ollama', model: 'llama3.2:1b' },
        },
        models: {},
      },
      'test',
    );
    expect(config.deployments.named).toMatchObject({
      adapter: 'openai-compatible',
      provider: 'groq',
      healthCheck: 'models',
    });
    expect(config.deployments.unnamed).toMatchObject({
      provider: 'openai-compatible',
      healthCheck: 'none',
    });
    expect(config.deployments.legacy).toMatchObject({ adapter: 'ollama', provider: 'ollama' });
  });

  it('accepts ${NAME} placeholders in a base URL and fills them from the environment', () => {
    const url = 'https://api.example.com/accounts/${ACCOUNT_ID}/v1';
    const config = parseModelsConfig(
      {
        deployments: {
          d: { adapter: 'openai-compatible', model: 'm', baseUrl: url, apiKeyEnv: 'KEY' },
        },
        models: {},
      },
      'test',
    );
    expect(config.deployments.d).toMatchObject({ baseUrl: url });
    expect(baseUrlVariables(url)).toEqual(['ACCOUNT_ID']);
    expect(expandBaseUrl(url, { ACCOUNT_ID: 'a/b?c' })).toEqual({
      url: 'https://api.example.com/accounts/a%2Fb%3Fc/v1',
    });
    expect(expandBaseUrl(url, {})).toEqual({ missing: 'ACCOUNT_ID' });
    expect(expandBaseUrl(url, { ACCOUNT_ID: '' })).toEqual({ missing: 'ACCOUNT_ID' });

    const problems = problemsOf(() =>
      parseModelsConfig(
        {
          deployments: {
            d: { adapter: 'openai-compatible', model: 'm', baseUrl: 'ftp://x', apiKeyEnv: 'K' },
          },
          models: {},
        },
        'm.json',
      ),
    );
    expect(problems.join('\n')).toMatch(/deployments\.d\.baseUrl/);
  });

  it('marks targets as last resort only when asked', () => {
    const config = parseModelsConfig(
      {
        deployments: { a: { adapter: 'mock' }, b: { adapter: 'mock' } },
        models: {
          m: {
            policy: 'cost_aware',
            targets: [{ deployment: 'a' }, { deployment: 'b', lastResort: true }],
          },
        },
      },
      'test',
    );
    expect(modelRoute(config.models.m!).targets).toEqual([
      { deployment: 'a', weight: 1, lastResort: false },
      { deployment: 'b', weight: 1, lastResort: true },
    ]);
  });

  it('rejects a model that points at an unknown deployment', () => {
    const problems = problemsOf(() =>
      parseModelsConfig({ deployments: {}, models: { 'gpt-x': { deployment: 'nope' } } }, 'm.json'),
    );
    expect(problems).toEqual(['m.json: models.gpt-x.deployment: unknown deployment "nope"']);
  });

  it('rejects unknown fields and invalid values, naming each', () => {
    const problems = problemsOf(() =>
      parseModelsConfig(
        {
          deployments: { m: { provider: 'mock', timeoutMs: 0, colour: 'blue' } },
          models: {},
        },
        'm.json',
      ),
    );
    expect(problems.some((p) => p.includes('deployments.m.timeoutMs'))).toBe(true);
    expect(problems.some((p) => p.includes('colour'))).toBe(true);
  });

  describe('embeddings routes (ADR 029)', () => {
    const gemini = (dimensions: number, model = 'gemini-embedding-001') => ({
      adapter: 'openai-compatible',
      provider: 'gemini',
      type: 'embeddings',
      model,
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'GEMINI_API_KEY',
      embedding: { dimensions },
    });
    const parse = (deployments: Record<string, unknown>, targets: string[]) =>
      problemsOf(() =>
        parseModelsConfig(
          {
            deployments,
            models: { m: { targets: targets.map((deployment) => ({ deployment })) } },
          },
          'm.json',
        ),
      );

    it('accepts fallback between deployments of one model with the same dimensions', () => {
      const config = parseModelsConfig(
        {
          deployments: { a: gemini(3072), b: gemini(3072) },
          models: { m: { targets: [{ deployment: 'a' }, { deployment: 'b' }] } },
        },
        'm.json',
      );
      expect(config.deployments.a).toMatchObject({
        type: 'embeddings',
        embedding: { dimensions: 3072 },
      });
    });

    it('rejects an embeddings route that mixes models', () => {
      expect(parse({ a: gemini(3072), b: gemini(3072, 'other-embed') }, ['a', 'b'])).toEqual([
        'm.json: models.m: an embeddings model falls back only between deployments of one model: ' +
          '"a" serves gemini-embedding-001, "b" serves other-embed',
      ]);
    });

    it('rejects an embeddings route that mixes dimensions', () => {
      expect(parse({ a: gemini(3072), b: gemini(768) }, ['a', 'b'])).toEqual([
        'm.json: models.m: an embeddings model falls back only between deployments with the ' +
          'same dimensions ("a", "b")',
      ]);
    });

    it('rejects an embeddings route that falls back to the mock', () => {
      const mock = { adapter: 'mock', type: 'embeddings', embedding: { dimensions: 3072 } };
      expect(parse({ a: gemini(3072), mock }, ['a', 'mock'])).toEqual([
        'm.json: models.m: an embeddings model never falls back to or from the mock ("a", "mock")',
      ]);
    });

    it('rejects a chat route that lists an embeddings deployment, and the reverse', () => {
      const chat = { adapter: 'mock' };
      expect(parse({ chat, e: gemini(3072) }, ['chat', 'e'])).toEqual([
        'm.json: models.m: a chat model cannot list the embeddings deployment "e"',
      ]);
      expect(parse({ chat, e: gemini(3072) }, ['e', 'chat'])).toEqual([
        'm.json: models.m: an embeddings model cannot list the chat deployment "chat"',
      ]);
    });

    it('needs dimensions for an embeddings deployment, and only there', () => {
      const missing = { adapter: 'mock', type: 'embeddings' };
      const stray = { adapter: 'mock', embedding: { dimensions: 8 } };
      const outside = {
        adapter: 'mock',
        type: 'embeddings',
        embedding: { dimensions: 8, dimensionsRange: { min: 16, max: 32 } },
      };
      expect(parse({ missing }, ['missing'])).toEqual([
        'm.json: deployments.missing.embedding: an embeddings deployment needs embedding.dimensions',
      ]);
      expect(parse({ stray }, ['stray'])).toEqual([
        'm.json: deployments.stray.embedding: embedding is only for "type": "embeddings"',
      ]);
      expect(parse({ outside }, ['outside'])).toEqual([
        'm.json: deployments.outside.embedding: embedding.dimensionsRange must include embedding.dimensions',
      ]);
    });

    it('refuses a chat health check on an embeddings deployment', () => {
      expect(parse({ a: { ...gemini(3072), healthCheck: 'chat' } }, ['a'])).toEqual([
        'm.json: deployments.a.healthCheck: an embeddings deployment cannot have a chat health check',
      ]);
    });
  });

  it('rejects deployment ids that are not simple names', () => {
    const problems = problemsOf(() =>
      parseModelsConfig({ deployments: { 'Bad Id': { provider: 'mock' } }, models: {} }, 'm.json'),
    );
    expect(problems.join('\n')).toMatch(/lowercase letters/);
  });

  it('reports a missing file as a config error', () => {
    const problems = problemsOf(() => readModelsConfig('does-not-exist.json'));
    expect(problems[0]).toMatch(/^does-not-exist\.json: cannot read models config/);
  });

  it('ships a valid default config', () => {
    const path = fileURLToPath(new URL('../config/models.json', import.meta.url));
    const config = readModelsConfig(path);
    expect(Object.keys(config.models)).toContain('mock-1');
    expect(config.models['mock-failover']).toMatchObject({ policy: 'priority' });
  });
});
