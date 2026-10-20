import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, commonConfigShape, parseConfig } from './config.js';

const schema = z.object(commonConfigShape);
const validEnv = {
  DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseConfig', () => {
  it('applies defaults to a minimal valid env', () => {
    expect(parseConfig(schema, validEnv)).toEqual({
      ...validEnv,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10_000,
    });
  });

  it('coerces numeric strings', () => {
    const config = parseConfig(schema, { ...validEnv, SHUTDOWN_TIMEOUT_MS: '2500' });
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(2500);
  });

  it('treats empty strings as unset so defaults apply', () => {
    const config = parseConfig(schema, { ...validEnv, LOG_LEVEL: '' });
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('reports every problem, naming missing variables as required', () => {
    let error: unknown;
    try {
      parseConfig(schema, { REDIS_URL: 'http://localhost', LOG_LEVEL: 'loud' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    expect(problems).toContain('DATABASE_URL: is required');
    expect(problems.some((p) => p.startsWith('REDIS_URL: '))).toBe(true);
    expect(problems.some((p) => p.startsWith('LOG_LEVEL: '))).toBe(true);
    expect((error as ConfigError).message).toMatch(/^Invalid configuration:\n {2}- /);
  });

  it('never echoes values, which may be secrets', () => {
    const secretUrl = 'mysql://user:hunter2@db:3306/x';
    expect(() => parseConfig(schema, { ...validEnv, DATABASE_URL: secretUrl })).toThrow(
      ConfigError,
    );
    try {
      parseConfig(schema, { ...validEnv, DATABASE_URL: secretUrl });
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });

  it('rejects non-positive timeouts', () => {
    expect(() => parseConfig(schema, { ...validEnv, SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(
      /SHUTDOWN_TIMEOUT_MS/,
    );
  });
});
