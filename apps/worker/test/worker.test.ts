import { Writable } from 'node:stream';
import { parseConfig } from '@ai-gateway/shared';
import { createLogger } from '@ai-gateway/shared/node';
import { describe, expect, it, vi } from 'vitest';
import { workerConfigSchema } from '../src/config.js';
import { createWorker } from '../src/worker.js';

function capture() {
  const messages: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line) messages.push((JSON.parse(line) as { msg: string }).msg);
      }
      callback();
    },
  });
  return { messages, logger: createLogger({ name: 'worker', level: 'info', destination }) };
}

describe('worker against real dependencies', () => {
  it('connects to Redis, then stops cleanly', async () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
    });
    const { messages, logger } = capture();
    const worker = createWorker(config, logger);

    worker.start();
    await vi.waitFor(() => expect(messages).toContain('redis connection ready'), {
      timeout: 5_000,
    });

    expect(await worker.stop()).toBe('stopped');
    expect(messages).toEqual(['worker started', 'redis connection ready', 'worker stopped']);
  });

  it('stops promptly even when Redis is unreachable', async () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: 'redis://127.0.0.1:1',
      SHUTDOWN_TIMEOUT_MS: '2000',
    });
    const { logger } = capture();
    const worker = createWorker(config, logger);
    worker.start();

    expect(await worker.stop()).toBe('stopped');
  });
});
