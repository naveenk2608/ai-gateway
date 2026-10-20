import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { parseConfig, type ManualClock } from '@ai-gateway/shared';
import { createLogger, type Logger } from '@ai-gateway/shared/node';
import { vi } from 'vitest';
import { gatewayConfigSchema, type GatewayConfig } from '../src/config.js';
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
