/**
 * The production wiring from src/main.ts plus one slow route, run as a child process by
 * shutdown-signal.test.ts so a real SIGTERM can be sent to it.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { parseConfig } from '@ai-gateway/shared';
import { createLogger, onShutdownSignal } from '@ai-gateway/shared/node';
import { gatewayConfigSchema } from '../../src/config.js';
import { createGateway } from '../../src/gateway.js';
import { parseModelsConfig } from '../../src/models-config.js';

const config = parseConfig(gatewayConfigSchema, process.env);
const logger = createLogger({ name: 'gateway', level: config.LOG_LEVEL });
const models = parseModelsConfig({ deployments: {}, models: {} }, 'fixture');
const gateway = createGateway(config, logger, { models });
const slowMs = Number(process.env.SLOW_MS ?? '1000');

gateway.app.get('/slow', async () => {
  process.send?.({ type: 'slow-request-started' });
  await sleep(slowMs);
  return { done: true };
});

onShutdownSignal(logger, async () => ((await gateway.shutdown()) === 'drained' ? 0 : 1));

await gateway.start();
const { port } = gateway.app.server.address() as AddressInfo;
process.send?.({ type: 'listening', port });
