import { fileURLToPath } from 'node:url';
import { ConfigError } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { parseModelsConfig, readModelsConfig } from './models-config.js';

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
      provider: 'mock',
      model: 'mock',
      timeoutMs: 60_000,
      streamIdleTimeoutMs: 30_000,
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
  });
});
