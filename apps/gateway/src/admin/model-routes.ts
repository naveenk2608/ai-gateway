import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ADAPTERS, modelRoute, ROUTING_POLICIES, type ModelsConfig } from '../models-config.js';
import { urlHost, type ProviderRegistry } from '../providers/registry.js';
import { errorResponses, type AdminDeps } from './schemas.js';

export const modelCatalogSchema = z.object({
  deployments: z.array(
    z.object({
      id: z.string(),
      /** Who serves it (groq, gemini, mock, ...), from the models file. */
      provider: z.string(),
      /** The wire protocol it is called with. */
      adapter: z.enum(ADAPTERS),
      /**
       * Host of the base URL (`api.groq.com`), never its path, which can hold an account ID. Null
       * for the mock, and for a deployment whose URL needs a variable that is unset.
       */
      baseUrlHost: z.string().nullable(),
      /** `none`: never probed while its breaker is open; it half-opens after BREAKER_OPEN_MS. */
      healthCheck: z.enum(['models', 'none']),
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
      targets: z.array(
        z.object({ deployment: z.string(), weight: z.number(), lastResort: z.boolean() }),
      ),
      /** False when none of its deployments is enabled: requests get 404. */
      available: z.boolean(),
    }),
  ),
});
export type ModelCatalog = z.output<typeof modelCatalogSchema>;

/**
 * The deployments and routing policies the gateway loaded from its models file. Only the host of
 * each base URL is shown; paths and the names of key variables are left out.
 */
export function modelCatalog(config: ModelsConfig, registry: ProviderRegistry): ModelCatalog {
  return {
    deployments: Object.entries(config.deployments)
      .map(([id, d]) => ({
        id,
        provider: d.provider,
        adapter: d.adapter,
        baseUrlHost:
          registry.deployment(id)?.baseUrlHost ??
          (d.adapter === 'mock' || d.baseUrl === undefined || d.baseUrl.includes('${')
            ? null
            : urlHost(d.baseUrl)),
        healthCheck: d.adapter === 'mock' ? ('models' as const) : d.healthCheck,
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
