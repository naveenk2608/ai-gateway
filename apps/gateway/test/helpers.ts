import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  parseConfig,
  systemClock,
  uuidv7,
  type Clock,
  type ManualClock,
  type UsageEvent,
} from '@ai-gateway/shared';
import { createLogger, type Logger } from '@ai-gateway/shared/node';
import { vi } from 'vitest';
import { generateApiKey, hashSecret } from '../src/auth/api-keys.js';
import { KeyVerifier } from '../src/auth/key-verifier.js';
import { UNLIMITED } from '../src/limits/policy.js';
import { gatewayConfigSchema, type GatewayConfig } from '../src/config.js';
import type { EventBus } from '../src/events/bus.js';
import { parseModelsConfig, type ModelsConfig } from '../src/models-config.js';

/** One random pepper per test run: no secret is committed, and keys from other runs never match. */
export const TEST_PEPPER = randomBytes(32).toString('hex');

/** Gateway config for integration tests: Compose services, a random port, the test pepper. */
export function testConfig(overrides: Record<string, string | undefined> = {}): GatewayConfig {
  return parseConfig(gatewayConfigSchema, {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    PORT: '0',
    API_KEY_PEPPER: TEST_PEPPER,
    ...overrides,
  });
}

export type LogLine = Record<string, unknown> & { msg?: string; requestId?: string };

/** A logger whose JSON lines are collected in memory for assertions. */
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
  return { logger: createLogger({ name: 'gateway', level: 'info', destination }), lines };
}

/** A models config with no deployments, for tests that do not call providers. */
export const noModels: ModelsConfig = parseModelsConfig({ deployments: {}, models: {} }, 'test');

/**
 * Waits (in real time) until code under test has queued `count` sleeps on the manual clock, so the
 * test can advance time knowing the waits it wants to skip have started.
 */
export async function sleepsQueued(clock: ManualClock, count: number): Promise<void> {
  await vi.waitFor(() => {
    if (clock.pendingSleeps < count)
      throw new Error(`${clock.pendingSleeps}/${count} sleeps queued`);
  });
}

/** The `data:` payload of each event in an SSE body, in order. */
export function sseData(body: string): string[] {
  return body
    .split('\n\n')
    .filter((event) => event.trim() !== '')
    .map((event) =>
      event
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n'),
    );
}

/** A promise plus its resolver, for holding a request open until the test releases it. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A verifier that knows one key, with no database, for tests of the /v1 routes. */
export function inMemoryVerifier(clock: Clock = systemClock) {
  const key = generateApiKey();
  const record = {
    apiKeyId: uuidv7(),
    keyId: key.keyId,
    projectId: uuidv7(),
    secretHash: hashSecret(key.secret, TEST_PEPPER),
    expiresAt: null,
    revokedAt: null,
    allowedModels: null,
    policy: UNLIMITED,
  };
  const verifier = new KeyVerifier({
    load: (keyId) => Promise.resolve(keyId === key.keyId ? record : null),
    pepper: TEST_PEPPER,
    clock,
    ttlMs: 0,
  });
  return { verifier, authorization: `Bearer ${key.plaintext}`, record };
}

/** An EventBus that keeps published events in memory. */
export class RecordingBus implements EventBus {
  readonly events: UsageEvent[] = [];

  publish(event: UsageEvent): void {
    this.events.push(event);
  }

  stats() {
    return { buffered: 0, published: this.events.length, dropped: 0 };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
