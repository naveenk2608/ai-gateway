import { ConfigError, parseConfig } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { gatewayConfigSchema } from './config.js';

const required = {
  DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY_PEPPER: 'x'.repeat(32),
};

function problems(env: Record<string, string>): readonly string[] {
  try {
    parseConfig(gatewayConfigSchema, env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

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

  it('requires a pepper of at least 32 characters, without echoing it', () => {
    expect(problems({ ...required, API_KEY_PEPPER: '' })).toEqual(['API_KEY_PEPPER: is required']);
    const short = problems({ ...required, API_KEY_PEPPER: 'short-secret-value' });
    expect(short).toEqual(['API_KEY_PEPPER: must be at least 32 characters']);
    expect(short.join()).not.toContain('short-secret-value');
  });

  it('allows no cross-origin browser calls unless ALLOWED_ORIGINS lists origins', () => {
    expect(parseConfig(gatewayConfigSchema, required).ALLOWED_ORIGINS).toEqual([]);
    const config = parseConfig(gatewayConfigSchema, {
      ...required,
      ALLOWED_ORIGINS: ' https://playground.example.com/ , http://localhost:5174',
    });
    expect(config.ALLOWED_ORIGINS).toEqual([
      'https://playground.example.com',
      'http://localhost:5174',
    ]);
  });

  it('rejects ALLOWED_ORIGINS entries that are not exact origins', () => {
    for (const value of ['*', 'https://app.example.com/path', 'app.example.com', 'ftp://x.com']) {
      expect(problems({ ...required, ALLOWED_ORIGINS: value })[0]).toMatch(
        /^ALLOWED_ORIGINS: use comma-separated origins/,
      );
    }
  });

  it('leaves metrics off by default, with any listener on loopback', () => {
    const config = parseConfig(gatewayConfigSchema, required);
    expect(config.METRICS_TOKEN).toBeUndefined();
    expect(config.METRICS_PORT).toBeUndefined();
    expect(config.METRICS_HOST).toBe('127.0.0.1');
  });

  it('requires a metrics token of at least 32 characters, without echoing it', () => {
    const found = problems({ ...required, METRICS_TOKEN: 'short-token' });
    expect(found).toEqual(['METRICS_TOKEN: must be at least 32 characters']);
    expect(found.join('')).not.toContain('short-token');
  });

  it('migrates on start and leaves bootstrap off by default', () => {
    const config = parseConfig(gatewayConfigSchema, required);
    expect(config).toMatchObject({ MIGRATE_ON_START: true, API_KEY_CACHE_TTL_MS: 30_000 });
    expect(config.BOOTSTRAP_ADMIN_EMAIL).toBeUndefined();
    expect(config.BOOTSTRAP_API_KEY).toBeUndefined();
    expect(
      parseConfig(gatewayConfigSchema, { ...required, MIGRATE_ON_START: 'false' }),
    ).toMatchObject({ MIGRATE_ON_START: false });
  });

  it('needs the bootstrap admin email and password together', () => {
    expect(problems({ ...required, BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com' })).toEqual([
      'BOOTSTRAP_ADMIN_PASSWORD: is required',
    ]);
    expect(problems({ ...required, BOOTSTRAP_ADMIN_PASSWORD: 'long-enough-password' })).toEqual([
      'BOOTSTRAP_ADMIN_PASSWORD: set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD together',
    ]);
  });

  it('rejects a bootstrap API key that is not in the gateway format', () => {
    expect(problems({ ...required, BOOTSTRAP_API_KEY: 'sk-not-a-gateway-key' })[0]).toMatch(
      /^BOOTSTRAP_API_KEY: must look like gw_/,
    );
  });
});
