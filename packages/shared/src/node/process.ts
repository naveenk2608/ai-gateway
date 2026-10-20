import type { z } from 'zod';
import type { Logger } from 'pino';
import { ConfigError, parseConfig } from '../config.js';

/** Reads config once at startup; on invalid config prints the problems and exits with code 1. */
export function loadConfigOrExit<S extends z.ZodType>(schema: S): z.output<S> {
  try {
    return parseConfig(schema, process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

type Exit = (code: number) => void;

/**
 * Runs `shutdown` once on SIGTERM or SIGINT and exits with the code it returns. A second signal
 * exits at once with code 1. Uncaught errors are logged and exit with code 1.
 */
export function onShutdownSignal(
  logger: Logger,
  shutdown: (signal: NodeJS.Signals) => Promise<number>,
  exit: Exit = (code) => process.exit(code),
): void {
  let stopping = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (stopping) {
      logger.warn({ signal }, 'second shutdown signal, exiting immediately');
      exit(1);
      return;
    }
    stopping = true;
    logger.info({ signal }, 'shutdown signal received');
    shutdown(signal).then(exit, (err: unknown) => {
      logger.error({ err }, 'shutdown failed');
      exit(1);
    });
  };

  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    exit(1);
  });
}
