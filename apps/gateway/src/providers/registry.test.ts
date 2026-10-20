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

describe('createRegistry', () => {
  it('disables a hosted deployment whose API key variable is not set', async () => {
    const { logger, lines } = captureLogger();
    const registry = createRegistry(config, { clock: systemClock, logger, env: {} });

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
      clock: systemClock,
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
