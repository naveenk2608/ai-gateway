/**
 * A gateway process with one model that holds each request for a minute, run by
 * limits-acceptance.test.ts so it can be killed mid-request, as a crash would.
 */
import type { AddressInfo } from 'node:net';
import { parseConfig } from '@ai-gateway/shared';
import { createLogger } from '@ai-gateway/shared/node';
import { gatewayConfigSchema } from '../../src/config.js';
import { createGateway } from '../../src/gateway.js';
import { parseModelsConfig } from '../../src/models-config.js';

const config = parseConfig(gatewayConfigSchema, process.env);
const logger = createLogger({ name: 'gateway', level: config.LOG_LEVEL });
const models = parseModelsConfig(
  {
    deployments: { held: { provider: 'mock', mock: { latencyMs: 60_000 } } },
    models: { 'mock-held': { deployment: 'held' } },
  },
  'fixture',
);
const gateway = createGateway(config, logger, { models });
await gateway.start();
const { port } = gateway.app.server.address() as AddressInfo;
process.send?.({ type: 'listening', port });
