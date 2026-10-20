import { ConfigError, parseConfig } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { workerConfigSchema } from './config.js';

describe('workerConfigSchema', () => {
  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => parseConfig(workerConfigSchema, {})).toThrow(ConfigError);
  });

  it('applies shared defaults', () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config).toMatchObject({ LOG_LEVEL: 'info', SHUTDOWN_TIMEOUT_MS: 10_000 });
  });

  it('serves metrics on loopback port 9465 by default, with no token', () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config).toMatchObject({ METRICS_HOST: '127.0.0.1', WORKER_METRICS_PORT: 9465 });
    expect(config.METRICS_TOKEN).toBeUndefined();
  });
});
