import { createLogger, loadConfigOrExit, onShutdownSignal } from '@ai-gateway/shared/node';
import { workerConfigSchema } from './config.js';
import { createWorker } from './worker.js';

const config = loadConfigOrExit(workerConfigSchema);
const logger = createLogger({ name: 'worker', level: config.LOG_LEVEL });
const worker = createWorker(config, logger);

onShutdownSignal(logger, async () => ((await worker.stop()) === 'stopped' ? 0 : 1));

try {
  await worker.start();
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
}
