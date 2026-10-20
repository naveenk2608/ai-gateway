/**
 * The mock provider as a standalone HTTP server (M9): `node dist/mock-server/main.js`, or
 * `pnpm mock:serve` from the repo root. Settings come from MOCK_SETTINGS, a JSON object with the
 * same fields as a deployment's `mock` block in config/models.json.
 */
import { commonConfigShape, systemClock } from '@ai-gateway/shared';
import { createLogger, loadConfigOrExit, onShutdownSignal } from '@ai-gateway/shared/node';
import { z } from 'zod';
import { mockSettingsSchema } from '../models-config.js';
import { startMockServer } from './server.js';

const config = loadConfigOrExit(
  z.object({
    LOG_LEVEL: commonConfigShape.LOG_LEVEL,
    MOCK_HOST: z.string().min(1).default('127.0.0.1'),
    MOCK_PORT: z.coerce.number().int().min(0).max(65_535).default(8090),
    MOCK_SETTINGS: z
      .string()
      .default('{}')
      .transform((text, ctx) => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON object' });
          return z.NEVER;
        }
      })
      .pipe(mockSettingsSchema),
  }),
);
const logger = createLogger({ name: 'mock-provider', level: config.LOG_LEVEL });

const server = await startMockServer({
  settings: config.MOCK_SETTINGS,
  clock: systemClock,
  host: config.MOCK_HOST,
  port: config.MOCK_PORT,
});
logger.info({ url: server.url, settings: config.MOCK_SETTINGS }, 'mock provider listening');

onShutdownSignal(logger, async () => {
  await server.close();
  return 0;
});
