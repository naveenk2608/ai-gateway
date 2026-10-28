import type { Clock } from '@ai-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiKeyAuth } from '../auth/api-key-auth.js';
import type { KeyVerifier } from '../auth/key-verifier.js';
import { GatewayError } from '../errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { errorBodySchema } from './schema.js';

const modelSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  /** Unix seconds: when this gateway loaded its models file, which has no dates of its own. */
  created: z.number().int(),
  owned_by: z.string(),
});

export const modelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(modelSchema),
});

export interface ModelRouteOptions {
  registry: ProviderRegistry;
  verifier: KeyVerifier;
  clock: Clock;
}

/**
 * `GET /v1/models` in OpenAI's format: the logical models a client may send to
 * `/v1/chat/completions` with this key. A model is listed when its project may use it (the
 * allow-list, if any) and at least one of its deployments is enabled.
 */
export function registerModels(app: FastifyInstance, options: ModelRouteOptions): void {
  const { registry, verifier, clock } = options;
  const created = Math.floor(clock.now() / 1000);
  if (!app.hasRequestDecorator('apiKey')) app.decorateRequest('apiKey', null);

  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/models',
    {
      onRequest: apiKeyAuth(verifier),
      schema: {
        tags: ['chat'],
        security: [{ apiKey: [] }],
        summary: 'List the models this API key may use (OpenAI-compatible)',
        response: { 200: modelListSchema, '4xx': errorBodySchema, '5xx': errorBodySchema },
      },
    },
    (request) => {
      const key = request.apiKey;
      // The onRequest hook guarantees a key.
      if (!key) {
        throw new GatewayError('internal_error', 'Internal server error', { httpStatus: 500 });
      }
      const allowed = key.allowedModels;
      const names = registry.modelNames().filter((name) => !allowed || allowed.includes(name));
      return {
        object: 'list' as const,
        data: names.map((id) => ({
          id,
          object: 'model' as const,
          created,
          owned_by: 'ai-gateway',
        })),
      };
    },
  );
}
