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

const usedSchema = z.object({ requests: z.number(), tokens: z.number() });

export const quotaUsageSchema = z.object({
  /** Null when Redis is unreachable: quota use is not known then (checks fail open, ADR 025). */
  deployments: z
    .array(
      z.object({
        deployment: z.string(),
        /** The free-tier quota from the models file; null for a deployment without one. */
        limits: z
          .object({
            requestsPerMinute: z.number().nullable(),
            requestsPerDay: z.number().nullable(),
            tokensPerMinute: z.number().nullable(),
            tokensPerDay: z.number().nullable(),
          })
          .nullable(),
        /** Counted in the current UTC minute and day, across every gateway instance. */
        minute: usedSchema,
        today: usedSchema,
        /** When the cooldown after an upstream 429 ends; null when none is running. */
        cooldownUntil: z.string().nullable(),
      }),
    )
    .nullable(),
});
export type QuotaUsageResponse = z.output<typeof quotaUsageSchema>;

export function registerModelRoutes(app: FastifyInstance, deps: AdminDeps): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/admin/models/quotas',
    {
      schema: {
        tags: ['admin'],
        summary: 'Free-tier quota use and 429 cooldowns per deployment (any user)',
        description:
          'Requests and tokens counted against each enabled deployment in the current UTC minute ' +
          'and day, its quota from the models file, and any cooldown. `deployments` is null ' +
          'while Redis is unreachable.',
        security: [{ session: [] }],
        response: { 200: quotaUsageSchema, ...errorResponses },
      },
    },
    async (request): Promise<QuotaUsageResponse> => {
      if (!deps.quotas) return { deployments: null };
      try {
        const usage = await deps.quotas();
        return {
          deployments: usage.map((u) => ({
            deployment: u.deployment,
            limits: u.limits && {
              requestsPerMinute: u.limits.requestsPerMinute ?? null,
              requestsPerDay: u.limits.requestsPerDay ?? null,
              tokensPerMinute: u.limits.tokensPerMinute ?? null,
              tokensPerDay: u.limits.tokensPerDay ?? null,
            },
            minute: u.minute,
            today: u.today,
            cooldownUntil:
              u.cooldownUntil === null ? null : new Date(u.cooldownUntil).toISOString(),
          })),
        };
      } catch (err) {
        request.log.warn({ err }, 'quota use unavailable');
        return { deployments: null };
      }
    },
  );
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
