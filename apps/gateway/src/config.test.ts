import { ConfigError, parseConfig } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { gatewayConfigSchema } from './config.js';

const required = {
  DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
};

describe('gatewayConfigSchema', () => {
  it('defaults to loopback on port 8080', () => {
    const config = parseConfig(gatewayConfigSchema, required);
    expect(config).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 8080,
      READY_CHECK_TIMEOUT_MS: 2_000,
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  it('takes HOST and PORT from the environment, as hosting platforms set them', () => {
    const config = parseConfig(gatewayConfigSchema, {
      ...required,
      HOST: '0.0.0.0',
      PORT: '10000',
    });
    expect(config).toMatchObject({ HOST: '0.0.0.0', PORT: 10_000 });
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseConfig(gatewayConfigSchema, { ...required, PORT: '70000' })).toThrow(
      ConfigError,
    );
  });
});
