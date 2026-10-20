import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { modelRoute, ROUTING_POLICIES, type ModelsConfig } from '../models-config.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { errorResponses, type AdminDeps } from './schemas.js';

export const modelCatalogSchema = z.object({
  deployments: z.array(
    z.object({
      id: z.string(),
      provider: z.enum(['mock', 'ollama', 'openai-compatible']),
      providerModel: z.string(),
      /** False when the deployment could not be created, e.g. its API key variable is unset. */
      enabled: z.boolean(),
      timeoutMs: z.number(),
      streamIdleTimeoutMs: z.number(),
      maxOutputTokens: z.number(),
    }),
  ),
  models: z.array(
    z.object({
      name: z.string(),
      policy: z.enum(ROUTING_POLICIES),
      targets: z.array(z.object({ deployment: z.string(), weight: z.number() })),
      /** False when none of its deployments is enabled: requests get 404. */
      available: z.boolean(),
    }),
  ),
});
export type ModelCatalog = z.output<typeof modelCatalogSchema>;

/**
 * The deployments and routing policies the gateway loaded from its models file. Base URLs and the
 * names of key variables are left out: they describe the host, not the routing.
 */
export function modelCatalog(config: ModelsConfig, registry: ProviderRegistry): ModelCatalog {
  return {
    deployments: Object.entries(config.deployments)
      .map(([id, d]) => ({
        id,
        provider: d.provider,
        providerModel: d.model,
        enabled: registry.deployment(id) !== undefined,
        timeoutMs: d.timeoutMs,
        streamIdleTimeoutMs: d.streamIdleTimeoutMs,
        maxOutputTokens: d.maxOutputTokens,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    models: Object.entries(config.models)
      .map(([name, m]) => ({
        name,
        ...modelRoute(m),
        available: registry.route(name) !== undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function registerModelRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/admin/models',
    {
      schema: {
        tags: ['admin'],
        summary: 'Configured deployments and routing policies (read-only, any user)',
        description: 'Loaded from the models file at startup; change the file to change them.',
        security: [{ session: [] }],
        response: { 200: modelCatalogSchema, ...errorResponses },
      },
    },
    () => deps.models,
  );
}
