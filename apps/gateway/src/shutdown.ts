import type { Server } from 'node:http';

export type DrainOutcome = 'drained' | 'timeout';

/** The parts of a Fastify instance the drain needs. */
export interface Drainable {
  server: Server;
  log: { warn(obj: object, msg: string): void };
  close(): PromiseLike<unknown>;
}

/**
 * Stops accepting connections, waits for in-flight requests, then runs onClose hooks (which
 * close the pools). `timeoutMs` bounds all of it: when it passes, remaining sockets are destroyed
 * and 'timeout' is returned without waiting further, so the caller can exit.
 */
export async function drainAndClose(app: Drainable, timeoutMs: number): Promise<DrainOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const closing = Promise.resolve(app.close()).then(() => 'drained' as const);

  const outcome = await Promise.race([closing, timedOut]);
  clearTimeout(timer);

  if (outcome === 'timeout') {
    app.log.warn({ timeoutMs }, 'shutdown timeout reached, closing remaining connections');
    app.server.closeAllConnections();
  }
  return outcome;
}
