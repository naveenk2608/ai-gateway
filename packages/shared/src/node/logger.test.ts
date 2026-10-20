import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes JSON lines with the service name, level and ISO time', () => {
    const { lines, stream } = capture();
    createLogger({ name: 'gateway', level: 'info', destination: stream }).info('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'gateway', level: 30, msg: 'hello' });
    expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts credentials in headers and secret-looking fields', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'gateway', level: 'info', destination: stream });
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer gw_key_secret',
            'x-api-key': 'gw_key_secret',
            cookie: 'session=abc',
            accept: 'application/json',
          },
        },
        user: { password: 'hunter2', email: 'a@example.com' },
      },
      'request',
    );
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('gw_key_secret');
    expect(serialized).not.toContain('session=abc');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('application/json');
    expect(serialized).toContain('[REDACTED]');
  });

  it('respects the configured level', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ name: 'worker', level: 'warn', destination: stream });
    logger.info('dropped');
    logger.warn('kept');
    expect(lines.map((l) => l.msg)).toEqual(['kept']);
  });
});
