import { createLogger, loadConfigOrExit, onShutdownSignal } from '@ai-gateway/shared/node';
import { gatewayConfigSchema } from './config.js';
import { createGateway } from './gateway.js';

const config = loadConfigOrExit(gatewayConfigSchema);
const logger = createLogger({ name: 'gateway', level: config.LOG_LEVEL });
const gateway = createGateway(config, logger);

onShutdownSignal(logger, async () => ((await gateway.shutdown()) === 'drained' ? 0 : 1));

try {
  await gateway.start();
} catch (err) {
  logger.fatal({ err }, 'gateway failed to start');
  process.exit(1);
}
