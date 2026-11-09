import {
  createLogger,
  initTracing,
  loadConfigOrExit,
  onShutdownSignal,
  shutdownTracing,
} from '@ai-gateway/shared/node';
import { workerConfigSchema } from './config.js';
import { createWorker } from './worker.js';

const config = loadConfigOrExit(workerConfigSchema);
const logger = createLogger({ name: 'worker', level: config.LOG_LEVEL });
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set (ADR 037).
if (
  await initTracing({
    serviceName: 'ai-gateway-worker',
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  })
) {
  logger.info('tracing on: spans go to the OTLP endpoint');
}
const worker = createWorker(config, logger);

onShutdownSignal(logger, async () => {
  const outcome = await worker.stop();
  await shutdownTracing();
  return outcome === 'stopped' ? 0 : 1;
});

try {
  await worker.start();
} catch (err) {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
}
