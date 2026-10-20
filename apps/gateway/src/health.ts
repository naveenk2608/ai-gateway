import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessOptions {
  /** Named dependency checks, e.g. postgres and redis. Each must reject when the dependency is down. */
  checks: Record<string, ReadinessCheck>;
  timeoutMs: number;
}

export interface CheckResult {
  status: 'ok' | 'fail';
  /** Present on failure. Details go to the log, not the response, as they can name internal hosts. */
  reason?: 'timeout' | 'error';
  latencyMs: number;
}

export interface ReadyBody {
  status: 'ready' | 'not_ready';
  checks: Record<string, CheckResult>;
}

class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`check did not finish within ${timeoutMs} ms`);
    this.name = 'CheckTimeoutError';
  }
}

async function withTimeout(check: ReadinessCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(
  name: string,
  check: ReadinessCheck,
  timeoutMs: number,
  log: FastifyBaseLogger,
): Promise<CheckResult> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    await withTimeout(check, timeoutMs);
    return { status: 'ok', latencyMs: latency() };
  } catch (err) {
    const reason = err instanceof CheckTimeoutError ? 'timeout' : 'error';
    log.warn({ err, check: name, reason }, 'readiness check failed');
    return { status: 'fail', reason, latencyMs: latency() };
  }
}

/** `/health`: the process is up. `/ready`: every dependency answered within the timeout. */
export function registerHealthRoutes(app: FastifyInstance, options: ReadinessOptions): void {
  app.get('/health', () => ({ status: 'ok' }));

  app.get('/ready', async (request, reply): Promise<ReadyBody> => {
    const names = Object.keys(options.checks);
    const results = await Promise.all(
      names.map((name) => runCheck(name, options.checks[name]!, options.timeoutMs, request.log)),
    );
    const checks = Object.fromEntries(names.map((name, i) => [name, results[i]!]));
    const ready = results.every((r) => r.status === 'ok');
    void reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });
}
