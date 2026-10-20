import { systemClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger, noModels } from '../test/helpers.js';
import { buildApp } from './app.js';
import { createRegistry } from './providers/registry.js';
import { registerChatCompletions } from './proxy/chat-completions.js';

/** The app as createGateway assembles it, without the database and Redis clients. */
function gatewayApp() {
  const { logger } = captureLogger();
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const registry = createRegistry(noModels, {
    clock: systemClock,
    logger,
    env: {},
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
  void app.register((instance, _opts, done) => {
    registerChatCompletions(instance, { registry, clock: systemClock });
    done();
  });
  return app;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string };
  paths: Record<
    string,
    Record<string, { requestBody?: unknown; responses: Record<string, unknown> }>
  >;
}

describe('OpenAPI docs', () => {
  it('serves the Swagger UI at /docs', async () => {
    const res = await gatewayApp().inject('/docs');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('generates the spec from the route schemas', async () => {
    const res = await gatewayApp().inject('/docs/json');
    expect(res.statusCode).toBe(200);
    const doc = res.json<OpenApiDocument>();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('AI Gateway');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/chat/completions', '/health', '/ready']),
    );

    const chat = doc.paths['/v1/chat/completions']?.post;
    const body = (chat?.requestBody as { content: Record<string, { schema: unknown }> }).content[
      'application/json'
    ]?.schema as {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(body.required).toEqual(expect.arrayContaining(['model', 'messages']));
    expect(Object.keys(body.properties)).toEqual(
      expect.arrayContaining(['model', 'messages', 'stream', 'max_tokens', 'temperature']),
    );
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(chat?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '4XX', '5XX']),
    );
    expect(Object.keys(doc.paths['/ready']?.get?.responses ?? {})).toEqual(['200', '503']);
  });
});
