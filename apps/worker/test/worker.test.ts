import { randomBytes } from 'node:crypto';
import { parseConfig } from '@ai-gateway/shared';
import { closeRedis } from '@ai-gateway/shared/node';
import { describe, expect, it, vi } from 'vitest';
import { workerConfigSchema } from '../src/config.js';
import { createWorker } from '../src/worker.js';
import {
  captureLogger,
  connect,
  createProject,
  isolatedSettings,
  makeEvent,
  publish,
} from './fixtures.js';

describe('worker against real dependencies', () => {
  it('migrates, starts its consumer, then stops cleanly', async () => {
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
      WORKER_METRICS_PORT: '0',
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
      WORKER_METRICS_PORT: '0',
    });
    const worker = createWorker(config, captureLogger().logger);
    // The consumer cannot create its group without Redis, so start never resolves; stop anyway.
    void worker.start().catch(() => undefined);

    const started = Date.now();
    expect(['stopped', 'timeout']).toContain(await worker.stop());
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('worker metrics', () => {
  it('serves consumer and stream metrics on its own port, only with the token', async () => {
    const token = randomBytes(24).toString('hex');
    const settings = isolatedSettings();
    const config = parseConfig(workerConfigSchema, {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
      WORKER_METRICS_PORT: '0',
      METRICS_TOKEN: token,
    });
    const worker = createWorker({ ...config, ...settings }, captureLogger().logger);
    const { pool, db, redis } = connect();
    try {
      await worker.start();
      const projectId = await createProject(db);
      for (let i = 0; i < 3; i++) {
        await publish(redis, settings.EVENTS_STREAM, JSON.stringify(makeEvent({ projectId })));
      }
      await vi.waitFor(() => expect(worker.consumer.stats.processed).toBe(3), { timeout: 10_000 });

      const url = `http://127.0.0.1:${worker.metricsPort()}/metrics`;
      expect((await fetch(url)).status).toBe(401);
      const wrong = await fetch(url, { headers: { authorization: `Bearer ${'0'.repeat(48)}` } });
      expect(wrong.status).toBe(401);

      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('worker_events_consumed_total 3');
      expect(text).toContain('usage_stream_up 1');
      expect(text).toContain('usage_stream_lag 0');
      expect(text).toContain('usage_stream_pending 0');
      expect(text).toContain('usage_dlq_length 0');
      expect(text).toMatch(/^worker_batch_duration_seconds_count [1-3]$/m);
      expect(text).toMatch(/^worker_rollup_duration_seconds_count [1-3]$/m);
      expect(text).toContain('process_resident_memory_bytes');
    } finally {
      await worker.stop();
      await Promise.allSettled([pool.end(), closeRedis(redis)]);
    }
  });
});
