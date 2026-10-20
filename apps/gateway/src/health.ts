import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessOptions {
  /** Named dependency checks, e.g. postgres and redis. Each must reject when the dependency is down. */
  checks: Record<string, ReadinessCheck>;
  timeoutMs: number;
}

const checkResultSchema = z.object({
  status: z.enum(['ok', 'fail']),
  /** Present on failure. Details go to the log, not the response, as they can name internal hosts. */
  reason: z.enum(['timeout', 'error']).optional(),
  latencyMs: z.number(),
});

const readyBodySchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), checkResultSchema),
});

export type CheckResult = z.output<typeof checkResultSchema>;
export type ReadyBody = z.output<typeof readyBodySchema>;

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
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/health',
    {
      schema: {
        tags: ['operations'],
        summary: 'Liveness: the process is up',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  routes.get(
    '/ready',
    {
      schema: {
        tags: ['operations'],
        summary: 'Readiness: Postgres and Redis answered within the timeout',
        response: { 200: readyBodySchema, 503: readyBodySchema },
      },
    },
    async (request, reply): Promise<ReadyBody> => {
      const names = Object.keys(options.checks);
      const results = await Promise.all(
        names.map((name) => runCheck(name, options.checks[name]!, options.timeoutMs, request.log)),
      );
      const checks = Object.fromEntries(names.map((name, i) => [name, results[i]!]));
      const ready = results.every((r) => r.status === 'ok');
      void reply.code(ready ? 200 : 503);
      return { status: ready ? 'ready' : 'not_ready', checks };
    },
  );
}
