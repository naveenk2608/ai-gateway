import { systemClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { parseModelsConfig } from '../models-config.js';
import { createRegistry } from './registry.js';

const config = parseModelsConfig(
  {
    deployments: {
      local: { provider: 'mock' },
      hosted: {
        provider: 'openai-compatible',
        model: 'gpt-x',
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'EXAMPLE_API_KEY',
      },
    },
    models: { 'mock-1': { deployment: 'local' }, 'gpt-x': { deployment: 'hosted' } },
  },
  'test',
);

const deps = { clock: systemClock, ollamaBaseUrl: 'http://127.0.0.1:11434' };

describe('createRegistry', () => {
  it('disables a hosted deployment whose API key variable is not set', async () => {
    const { logger, lines } = captureLogger();
    const registry = createRegistry(config, { ...deps, logger, env: {} });

    expect(registry.route('mock-1')?.targets[0]?.deployment.provider.kind).toBe('mock');
    expect(registry.route('gpt-x')).toBeUndefined();
    expect(lines.find((l) => l.msg === 'deployment disabled')).toMatchObject({
      deployment: 'hosted',
      reason: 'EXAMPLE_API_KEY is not set',
    });
    expect(lines.find((l) => l.msg === 'model unavailable')).toMatchObject({ model: 'gpt-x' });
    await registry.close();
  });

  it('enables it when the key is present, and never logs the key', async () => {
    const { logger, lines } = captureLogger();
    const registry = createRegistry(config, {
      ...deps,
      logger,
      env: { EXAMPLE_API_KEY: 'sk-test-value-not-real' },
    });

    const deployment = registry.route('gpt-x')?.targets[0]?.deployment;
    expect(deployment?.provider.kind).toBe('openai-compatible');
    expect(deployment?.providerModel).toBe('gpt-x');
    expect(registry.modelNames()).toEqual(['mock-1', 'gpt-x']);
    expect(JSON.stringify(lines)).not.toContain('sk-test-value-not-real');
    await registry.close();
  });

  it('points Ollama deployments at OLLAMA_BASE_URL unless they set their own', async () => {
    const { logger } = captureLogger();
    const ollama = parseModelsConfig(
      {
        deployments: {
          shared: { provider: 'ollama', model: 'llama3.2:1b' },
          own: { provider: 'ollama', model: 'qwen', baseUrl: 'http://gpu-box:11434' },
        },
        models: { a: { deployment: 'shared' }, b: { deployment: 'own' } },
      },
      'test',
    );
    const registry = createRegistry(ollama, { ...deps, logger, env: {} });
    expect(registry.route('a')?.targets[0]?.deployment.provider.kind).toBe('ollama');
    expect(registry.route('b')?.targets[0]?.deployment.providerModel).toBe('qwen');
    await registry.close();
  });

  it('rejects an inline key-like value in apiKeyEnv', () => {
    expect(() =>
      parseModelsConfig(
        {
          deployments: {
            hosted: {
              provider: 'openai-compatible',
              model: 'gpt-x',
              baseUrl: 'https://api.example.com/v1',
              apiKeyEnv: 'sk-live-123',
            },
          },
          models: {},
        },
        'test',
      ),
    ).toThrow(/environment variable name/);
  });
});

describe('routes', () => {
  it('keeps the enabled targets of a model, in order, with their policy and weights', () => {
    const { logger } = captureLogger();
    const routed = parseModelsConfig(
      {
        deployments: {
          a: { provider: 'mock' },
          b: { provider: 'mock' },
          hosted: {
            provider: 'openai-compatible',
            model: 'x',
            baseUrl: 'https://api.example.com/v1',
            apiKeyEnv: 'MISSING_KEY',
          },
        },
        models: {
          spread: {
            policy: 'weighted',
            targets: [
              { deployment: 'hosted', weight: 5 },
              { deployment: 'b', weight: 3 },
              { deployment: 'a' },
            ],
          },
          'only-hosted': { deployment: 'hosted' },
        },
      },
      'test',
    );
    const registry = createRegistry(routed, { ...deps, logger, env: {} });
    const route = registry.route('spread');
    expect(route?.policy).toBe('weighted');
    expect(route?.targets.map((t) => [t.deployment.id, t.weight])).toEqual([
      ['b', 3],
      ['a', 1],
    ]);
    // Every target disabled: the model is unavailable.
    expect(registry.route('only-hosted')).toBeUndefined();
  });

  it('rejects unknown and repeated targets', () => {
    expect(() =>
      parseModelsConfig(
        {
          deployments: { a: { provider: 'mock' } },
          models: {
            m: { targets: [{ deployment: 'a' }, { deployment: 'a' }, { deployment: 'z' }] },
          },
        },
        'test',
      ),
    ).toThrow(/listed twice[\s\S]*unknown deployment "z"/);
  });
});
