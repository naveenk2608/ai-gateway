import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { uuidv7, type UsageEvent } from '@ai-gateway/shared';
import {
  createDb,
  createLogger,
  createPgPool,
  createRedis,
  type Db,
  type Logger,
  type Redis,
} from '@ai-gateway/shared/node';
import { consumerSettingsSchema, type ConsumerSettings } from '../src/config.js';

export type LogLine = Record<string, unknown> & { msg?: string };

export function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line) lines.push(JSON.parse(line) as LogLine);
      }
      callback();
    },
  });
  return { logger: createLogger({ name: 'worker', level: 'info', destination }), lines };
}

export function connect() {
  const { logger } = captureLogger();
  const pool = createPgPool(process.env.DATABASE_URL!, logger);
  const db = createDb(pool);
  const redis = createRedis(process.env.REDIS_URL!, logger, { offlineQueue: true });
  return { pool, db, redis };
}

/** Stream, DLQ and group names of their own, so tests never see each other's events. */
export function isolatedSettings(overrides: Partial<ConsumerSettings> = {}): ConsumerSettings {
  const tag = randomBytes(4).toString('hex');
  return {
    ...consumerSettingsSchema.parse({}),
    EVENTS_STREAM: `test:usage:${tag}`,
    EVENTS_DLQ_STREAM: `test:usage:${tag}:dlq`,
    EVENTS_CONSUMER_GROUP: `test-group-${tag}`,
    WORKER_BLOCK_MS: 100,
    WORKER_CLAIM_IDLE_MS: 200,
    ...overrides,
  };
}

export async function createProject(db: Db): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('projects')
    .values({ id, name: `worker-${randomBytes(3).toString('hex')}` })
    .execute();
  return id;
}

export interface EventOptions {
  projectId: string;
  provider?: string;
  providerModel?: string;
  startedAt?: Date;
  usage?: UsageEvent['usage'];
}

/** A completed, non-streaming request with one successful attempt. */
export function makeEvent({
  projectId,
  provider = 'mock',
  providerModel = 'mock',
  startedAt = new Date(),
  usage = { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 },
}: EventOptions): UsageEvent {
  const start = startedAt.getTime();
  const end = new Date(start + 120).toISOString();
  return {
    v: 1,
    type: 'request.completed',
    eventId: uuidv7(start + 120),
    occurredAt: end,
    request: {
      id: uuidv7(start),
      projectId,
      apiKeyId: null,
      model: 'mock-1',
      deployment: 'mock',
      stream: false,
      status: 'success',
      httpStatus: 200,
      errorCode: null,
      startedAt: startedAt.toISOString(),
      completedAt: end,
      latencyMs: 120,
      ttftMs: null,
    },
    attempts: [
      {
        id: uuidv7(start + 1),
        attemptNumber: 1,
        deployment: 'mock',
        provider,
        providerModel,
        outcome: 'success',
        upstreamStatus: null,
        routingPolicy: null,
        routingReason: null,
        startedAt: new Date(start + 1).toISOString(),
        completedAt: end,
        latencyMs: 119,
        ttftMs: null,
      },
    ],
    usage,
    usageSource: usage ? 'reported' : 'missing',
  };
}

export async function publish(redis: Redis, stream: string, payload: string): Promise<string> {
  return (await redis.call('XADD', stream, '*', 'event', payload)) as string;
}

export async function pendingCount(redis: Redis, settings: ConsumerSettings): Promise<number> {
  const summary = (await redis.call(
    'XPENDING',
    settings.EVENTS_STREAM,
    settings.EVENTS_CONSUMER_GROUP,
  )) as [number];
  return Number(summary[0]);
}
