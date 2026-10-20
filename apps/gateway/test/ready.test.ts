import type { AddressInfo } from 'node:net';
import { parseConfig } from '@ai-gateway/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayConfigSchema } from '../src/config.js';
import { createGateway, type Gateway } from '../src/gateway.js';
import { captureLogger, noModels } from './helpers.js';

/** Nothing listens on port 1, so connections are refused at once. */
const CLOSED_PORT_PG = 'postgres://gateway@127.0.0.1:1/gateway';
const CLOSED_PORT_REDIS = 'redis://127.0.0.1:1';

let running: Gateway | undefined;

async function start(overrides: Record<string, string> = {}) {
  const config = parseConfig(gatewayConfigSchema, {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    PORT: '0',
    READY_CHECK_TIMEOUT_MS: '1000',
    ...overrides,
  });
  const { logger } = captureLogger();
  running = createGateway(config, logger, { models: noModels });
  await running.start();
  const { port } = running.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('gateway readiness against real dependencies', () => {
  afterEach(async () => {
    await running?.shutdown();
    running = undefined;
  });

  it('is ready when Postgres and Redis are reachable', async () => {
    const url = await start();
    // The Redis client connects asynchronously after start.
    await vi.waitFor(
      async () => {
        const res = await fetch(`${url}/ready`);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          status: 'ready',
          checks: { postgres: { status: 'ok' }, redis: { status: 'ok' } },
        });
      },
      { timeout: 5_000, interval: 100 },
    );
  });

  it('is not ready when Redis is unreachable', async () => {
    const url = await start({ REDIS_URL: CLOSED_PORT_REDIS });
    const res = await fetch(`${url}/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'not_ready',
      checks: { postgres: { status: 'ok' }, redis: { status: 'fail' } },
    });
  });

  it('is not ready when Postgres is unreachable', async () => {
    const url = await start({ DATABASE_URL: CLOSED_PORT_PG });
    await vi.waitFor(
      async () => {
        const res = await fetch(`${url}/ready`);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          checks: { postgres: { status: 'fail' }, redis: { status: 'ok' } },
        });
      },
      { timeout: 5_000, interval: 100 },
    );
  });

  it('shuts down cleanly with both pools open', async () => {
    const url = await start();
    await vi.waitFor(async () => expect((await fetch(`${url}/ready`)).status).toBe(200), {
      timeout: 5_000,
      interval: 100,
    });
    const gateway = running!;
    running = undefined;
    expect(await gateway.shutdown()).toBe('drained');
    expect(gateway.app.server.listening).toBe(false);
  });
});
