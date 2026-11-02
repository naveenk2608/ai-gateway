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
