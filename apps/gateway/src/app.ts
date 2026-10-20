import { uuidv7 } from '@ai-gateway/shared';
import type { Logger } from '@ai-gateway/shared/node';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError } from 'fastify';
import { GatewayError } from './errors.js';
import { registerHealthRoutes, type ReadinessOptions } from './health.js';

export interface AppOptions {
  logger: Logger;
  readiness: ReadinessOptions;
}

const shuttingDown = new GatewayError('shutting_down', 'Server is shutting down, retry shortly', {
  httpStatus: 503,
  retryable: true,
});

const internalError = new GatewayError('internal_error', 'Internal server error', {
  httpStatus: 500,
});

export function buildApp({ logger, readiness }: AppOptions) {
  // Typed as Fastify's base logger so routes and plugins use the standard instance type.
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance,
    // Every request gets a server-generated ID; client-sent IDs are never trusted.
    genReqId: () => uuidv7(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // We answer requests that arrive while closing ourselves, in OpenAI error format (see preClose).
    return503OnClosing: false,
    forceCloseConnections: 'idle',
  });

  let closing = false;
  app.addHook('preClose', () => {
    closing = true;
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    // Requests on kept-alive sockets can still arrive during the drain; turn them away.
    if (closing) return reply.code(503).send(shuttingDown.toBody());
  });

  app.addHook('onSend', async (_request, reply) => {
    // While draining, close each kept-alive socket after its response; otherwise the drain waits
    // for the client's keep-alive timeout.
    if (closing) void reply.header('connection', 'close');
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const error = new GatewayError('not_found', `Invalid URL (${request.method} ${path})`, {
      httpStatus: 404,
    });
    return reply.code(404).send(error.toBody());
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof GatewayError) {
      if (err.httpStatus >= 500) request.log.error({ err }, 'request failed');
      return reply.code(err.httpStatus).send(err.toBody());
    }
    // Fastify's own 4xx errors (bad JSON, unsupported media type, body too large) have safe messages.
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      const error = new GatewayError(err.code ?? 'invalid_request', err.message, {
        httpStatus: err.statusCode,
      });
      return reply.code(err.statusCode).send(error.toBody());
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send(internalError.toBody());
  });

  registerHealthRoutes(app, readiness);

  return app;
}

export type App = ReturnType<typeof buildApp>;
