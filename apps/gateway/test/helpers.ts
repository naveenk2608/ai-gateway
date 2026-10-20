import { Writable } from 'node:stream';
import { createLogger, type Logger } from '@ai-gateway/shared/node';

export type LogLine = Record<string, unknown> & { msg?: string; requestId?: string };

/** A logger whose JSON lines are collected in memory for assertions. */
export function captureLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line) lines.push(JSON.parse(line) as LogLine);
      }
      callback();
    },
  });
  return { logger: createLogger({ name: 'gateway', level: 'info', destination }), lines };
}

/** A promise plus its resolver, for holding a request open until the test releases it. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
