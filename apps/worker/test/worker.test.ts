import { parseConfig } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { workerConfigSchema } from '../src/config.js';
import { createWorker } from '../src/worker.js';
import { captureLogger, isolatedSettings } from './fixtures.js';

describe('worker against real dependencies', () => {
  it('migrates, starts its consumer, then stops cleanly', async () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
    });
    const { logger, lines } = captureLogger();
    const worker = createWorker({ ...config, ...isolatedSettings() }, logger);

    await worker.start();
    const messages = lines.map((l) => l.msg);
    expect(messages).toContain('database migrations up to date');
    expect(messages).toContain('usage consumer started');
    expect(messages).toContain('worker started');

    expect(await worker.stop()).toBe('stopped');
    expect(lines.at(-1)?.msg).toBe('worker stopped');
  });

  it('stops promptly even when Redis is unreachable', async () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: 'redis://127.0.0.1:1',
      SHUTDOWN_TIMEOUT_MS: '2000',
      MIGRATE_ON_START: 'false',
    });
    const worker = createWorker(config, captureLogger().logger);
    // The consumer cannot create its group without Redis, so start never resolves; stop anyway.
    void worker.start().catch(() => undefined);

    const started = Date.now();
    expect(['stopped', 'timeout']).toContain(await worker.stop());
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
