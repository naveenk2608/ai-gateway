import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { IncomingMessage } from 'node:http';
import {
  startSpan,
  traceLogFields,
  formatTraceparent,
  uuidv7,
  type TraceContext,
} from '@ai-gateway/shared';
import { bearerMatches, type Logger } from '@ai-gateway/shared/node';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyReply,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodFastifySchemaValidationError,
} from 'fastify-type-provider-zod';
import { GatewayError } from './errors.js';
import { registerHealthRoutes, type ReadinessOptions } from './health.js';
import type { GatewayMetrics } from './metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** This request's span (ADR 017): continues the caller's `traceparent`, or starts a trace. */
    traceContext: TraceContext;
  }
}

export interface AppOptions {
  logger: Logger;
  readiness: ReadinessOptions;
  /** Trusted proxy hops for X-Forwarded-For (request.ip); 0 trusts none. */
  trustProxy?: number;
  /** Records every response; `GET /metrics` serves its registry when `metricsToken` is set. */
  metrics?: GatewayMetrics;
  /** Bearer token for `GET /metrics` on this port. Unset, the route does not exist (404). */
  metricsToken?: string;
}

const shuttingDown = new GatewayError('shutting_down', 'Server is shutting down, retry shortly', {
  httpStatus: 503,
  retryable: true,
});

const internalError = new GatewayError('internal_error', 'Internal server error', {
  httpStatus: 500,
});

const metricsUnauthorized = new GatewayError(
  'invalid_metrics_token',
  'Scraping /metrics needs `Authorization: Bearer <METRICS_TOKEN>`.',
  { httpStatus: 401 },
);

/** Request bodies above 1 MiB are rejected with 413 before parsing. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** `/messages/0/role` -> `messages[0].role` */
function toParam(instancePath: string): string {
  return instancePath
    .split('/')
    .filter((segment) => segment !== '')
    .reduce((path, segment) => {
      if (/^\d+$/.test(segment)) return `${path}[${segment}]`;
      return path === '' ? segment : `${path}.${segment}`;
    }, '');
}

function invalidRequest(issues: ZodFastifySchemaValidationError[]): GatewayError {
  const issue = issues[0];
  if (!issue) {
    return new GatewayError('invalid_request', 'Invalid request body', { httpStatus: 400 });
  }
  const path = toParam(issue.instancePath);
  const unknownKeys: unknown = issue.params['keys'];
  const firstUnknown: unknown = Array.isArray(unknownKeys)
    ? (unknownKeys as unknown[])[0]
    : undefined;
  const param = path !== '' ? path : typeof firstUnknown === 'string' ? firstUnknown : null;
  const where = path !== '' ? `${path}: ` : '';
  return new GatewayError('invalid_request', `Invalid request: ${where}${issue.message}`, {
    httpStatus: 400,
    param,
  });
}

function sendError(reply: FastifyReply, error: GatewayError) {
  if (error.retryAfterSeconds !== undefined) {
    void reply.header('retry-after', String(error.retryAfterSeconds));
  }
  // Read by OpenAI SDKs to decide whether to retry.
  void reply.header('x-should-retry', String(error.retryable));
  return reply.code(error.httpStatus).send(error.toBody());
}

export function buildApp({ logger, readiness, trustProxy = 0, metrics, metricsToken }: AppOptions) {
  // Typed as Fastify's base logger so routes and plugins use the standard instance type.
  const loggerInstance: FastifyBaseLogger = logger;
  // Spans are made with each request's logger, so its first log line already carries them.
  const spans = new WeakMap<IncomingMessage, TraceContext>();
  const app = Fastify({
    loggerInstance,
    childLoggerFactory(parent, bindings, options, rawRequest) {
      const header = rawRequest.headers.traceparent;
      const span = startSpan(typeof header === 'string' ? header : undefined);
      spans.set(rawRequest, span);
      return parent.child({ ...bindings, ...traceLogFields(span) }, options);
    },
    // Every request gets a server-generated ID; client-sent IDs are never trusted.
    genReqId: () => uuidv7(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // We answer requests that arrive while closing ourselves, in OpenAI error format (see preClose).
    return503OnClosing: false,
    forceCloseConnections: 'idle',
    bodyLimit: BODY_LIMIT_BYTES,
    // Trust the nearest `trustProxy` hops, as proxy-addr does for a number.
    trustProxy: trustProxy > 0 ? (_address: string, hop: number) => hop < trustProxy : false,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  let closing = false;
  app.addHook('preClose', () => {
    closing = true;
  });

  app.decorateRequest('traceContext', null as unknown as TraceContext);
  app.addHook('onRequest', async (request, reply) => {
    request.traceContext = spans.get(request.raw) ?? startSpan(undefined);
    void reply.header('x-request-id', request.id);
    void reply.header('traceparent', formatTraceparent(request.traceContext));
    // Requests on kept-alive sockets can still arrive during the drain; turn them away.
    if (closing) return sendError(reply, shuttingDown);
  });

  app.addHook('onSend', async (_request, reply) => {
    // While draining, close each kept-alive socket after its response; otherwise the drain waits
    // for the client's keep-alive timeout.
    if (closing) void reply.header('connection', 'close');
  });

  app.addHook('onResponse', (request, reply, done) => {
    // A stream whose headers went out before the drain began has no `Connection: close`, so close
    // its socket once it finishes rather than wait for the keep-alive timeout.
    if (closing) request.raw.socket?.destroySoon();
    metrics?.httpRequest(
      request.method,
      request.routeOptions.url,
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
    done();
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const error = new GatewayError('not_found', `Invalid URL (${request.method} ${path})`, {
      httpStatus: 404,
    });
    return sendError(reply, error);
  });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (err instanceof GatewayError) {
      if (err.httpStatus >= 500) request.log.error({ err }, 'request failed');
      return sendError(reply, err);
    }
    if (hasZodFastifySchemaValidationErrors(err))
      return sendError(reply, invalidRequest(err.validation));
    // Fastify's own 4xx errors (bad JSON, unsupported media type, body too large) have safe messages.
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      const error = new GatewayError(err.code ?? 'invalid_request', err.message, {
        httpStatus: err.statusCode,
      });
      return sendError(reply, error);
    }
    request.log.error({ err }, 'unhandled error');
    return sendError(reply, internalError);
  });

  // OpenAPI is generated from the same Zod schemas that validate requests (ADR 002). Swagger is
  // registered before any route plugin so it sees them all.
  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AI Gateway',
        version: '0.1.0',
        description:
          'OpenAI-compatible chat completions. Errors use the OpenAI error shape ' +
          '`{"error": {"message", "type", "param", "code"}}`.\n\n' +
          'To try `/v1` here, click **Authorize** and paste an API key (`gw_...`). Admin routes ' +
          'use the session cookie set by `POST /admin/auth/login`.',
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'A project API key, `gw_<keyId>_<secret>`.',
          },
          session: { type: 'apiKey', in: 'cookie', name: 'gw_session' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  void app.register(swaggerUi, { routePrefix: '/docs' });
  void app.register((instance, _opts, done) => {
    // The bare host has no page of its own; send visitors to the API docs.
    instance.get('/', { schema: { hide: true } }, (_request, reply) => reply.redirect('/docs'));
    registerHealthRoutes(instance, readiness);
    if (metrics && metricsToken !== undefined) {
      // Prometheus scrapes every few seconds; keep its requests out of the info log.
      instance.get(
        '/metrics',
        { schema: { hide: true }, logLevel: 'warn' },
        async (request, reply) => {
          if (!bearerMatches(request.headers.authorization, metricsToken)) {
            void reply.header('www-authenticate', 'Bearer realm="metrics"');
            return sendError(reply, metricsUnauthorized);
          }
          const body = await metrics.registry.metrics();
          return reply.header('content-type', metrics.registry.contentType).send(body);
        },
      );
    }
    done();
  });

  return app;
}

export type App = ReturnType<typeof buildApp>;
