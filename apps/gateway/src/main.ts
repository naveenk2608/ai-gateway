import { fileURLToPath } from 'node:url';
import { ConfigError } from '@ai-gateway/shared';
import { createLogger, loadConfigOrExit, onShutdownSignal } from '@ai-gateway/shared/node';
import { gatewayConfigSchema } from './config.js';
import { loadDashboard, type DashboardFiles } from './dashboard.js';
import { createGateway } from './gateway.js';
import { readModelsConfig, type ModelsConfig } from './models-config.js';

const config = loadConfigOrExit(gatewayConfigSchema);
const logger = createLogger({ name: 'gateway', level: config.LOG_LEVEL });

// src/ and dist/ are both one level below the package root, where config/ lives.
const modelsPath =
  config.MODELS_CONFIG_PATH ?? fileURLToPath(new URL('../config/models.json', import.meta.url));
let models: ModelsConfig;
let dashboard: DashboardFiles | undefined;
try {
  models = readModelsConfig(modelsPath);
  if (config.DASHBOARD_DIR !== undefined) dashboard = loadDashboard(config.DASHBOARD_DIR);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  process.stderr.write(`${err.message}
`);
  process.exit(1);
}

const gateway = createGateway(config, logger, { models, dashboard });

onShutdownSignal(logger, async () => ((await gateway.shutdown()) === 'drained' ? 0 : 1));

try {
  await gateway.start();
} catch (err) {
  logger.fatal({ err }, 'gateway failed to start');
  process.exit(1);
}
