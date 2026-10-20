import { pino, type DestinationStream, type Logger } from 'pino';
import type { LogLevel } from '../config.js';

export type { Logger } from 'pino';

/** Paths that may carry credentials. Fastify's default serializers omit headers, this is defence in depth. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers.cookie',
  '*.password',
  '*.apiKey',
  '*.secret',
];

export interface LoggerOptions {
  name: string;
  level: LogLevel;
  /** Defaults to stdout; tests pass a stream to capture lines. */
  destination?: DestinationStream;
}

export function createLogger({ name, level, destination }: LoggerOptions): Logger {
  const options = {
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}
