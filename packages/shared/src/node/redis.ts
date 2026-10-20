import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export type { Redis } from 'ioredis';

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    // Commands fail immediately while disconnected instead of queueing, so callers (readiness now,
    // fail-closed limits in M4) see the outage at once rather than hanging.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });

  // ioredis emits 'error' on every reconnect attempt; log only transitions to keep logs readable.
  let healthy: boolean | undefined;
  redis.on('ready', () => {
    if (healthy !== true) logger.info('redis connection ready');
    healthy = true;
  });
  redis.on('error', (err) => {
    if (healthy !== false) logger.warn({ err }, 'redis connection error, retrying');
    healthy = false;
  });
  return redis;
}

export async function pingRedis(redis: Redis): Promise<void> {
  await redis.ping();
}

/**
 * QUIT politely when connected; drop the socket when Redis is unreachable or does not answer
 * within `timeoutMs`, so shutdown never hangs.
 */
export async function closeRedis(redis: Redis, timeoutMs = 1_000): Promise<void> {
  if (redis.status === 'ready') {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      if ((await Promise.race([redis.quit(), timedOut])) !== 'timeout') return;
    } catch {
      // fall through to a hard disconnect
    } finally {
      clearTimeout(timer);
    }
  }
  redis.disconnect();
}
