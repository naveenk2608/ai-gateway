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

    expect(registry.resolve('mock-1')?.provider.kind).toBe('mock');
    expect(registry.resolve('gpt-x')).toBeUndefined();
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

    const deployment = registry.resolve('gpt-x');
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
    expect(registry.resolve('a')?.provider.kind).toBe('ollama');
    expect(registry.resolve('b')?.providerModel).toBe('qwen');
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
