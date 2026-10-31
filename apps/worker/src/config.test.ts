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

  it('reads events from Redis by default', () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config.EVENT_BUS).toBe('redis');
  });

  it('needs the queues and region, but not Redis, with EVENT_BUS=sqs', () => {
    const base = { DATABASE_URL: 'postgres://gateway@localhost:5432/gateway', EVENT_BUS: 'sqs' };
    expect(() => parseConfig(workerConfigSchema, base)).toThrow(
      /SQS_QUEUE_URL: is required[\s\S]*SQS_DLQ_URL: is required[\s\S]*AWS_REGION: is required/,
    );
    const config = parseConfig(workerConfigSchema, {
      ...base,
      SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/usage',
      SQS_DLQ_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/usage-dlq',
      AWS_REGION: 'us-east-1',
    });
    expect(config).toMatchObject({ EVENT_BUS: 'sqs', AWS_REGION: 'us-east-1' });
    expect(config.REDIS_URL).toBeUndefined();
  });

  it('still needs Redis when Redis carries the events', () => {
    expect(() =>
      parseConfig(workerConfigSchema, {
        DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
      }),
    ).toThrow(/REDIS_URL: is required/);
  });

  it('refuses a region that is not one', () => {
    expect(() =>
      parseConfig(workerConfigSchema, {
        DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
        REDIS_URL: 'redis://localhost:6379',
        AWS_REGION: 'virginia',
      }),
    ).toThrow(/AWS_REGION: must be an AWS region/);
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
