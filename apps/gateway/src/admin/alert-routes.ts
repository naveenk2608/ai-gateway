import { uuidv7 } from '@ai-gateway/shared';
import {
  ALERT_EVENTS,
  ALERT_KINDS,
  enqueueTestAlert,
  maskUrl,
  newSigningSecret,
  sealText,
} from '@ai-gateway/shared/node';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GatewayError } from '../errors.js';
import { currentUser, requireProjectRole } from './access.js';
import { writeAudit } from './audit.js';
import { errorResponses, iso, projectParams, type AdminDeps } from './schemas.js';

const security = [{ session: [] }];

export const alertDestinationSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ALERT_KINDS),
  /** The scheme, host and last 4 characters only; the URL itself is never sent back. */
  urlHint: z.string(),
  events: z.array(z.enum(ALERT_EVENTS)),
  createdAt: z.string(),
});

export const alertDeliverySchema = z.object({
  id: z.string(),
  destinationId: z.string(),
  destinationName: z.string(),
  eventType: z.enum(['budget.threshold', 'breaker.opened', 'dead_letters.growing', 'test']),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number(),
  lastStatus: z.number().nullable(),
  /** Why the last attempt failed; never the URL. */
  lastError: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
});

export const alertsResponseSchema = z.object({
  /** False when ALERTS_ENABLED is off or no encryption key can be made. */
  enabled: z.boolean(),
  destinations: z.array(alertDestinationSchema),
  /** The 50 most recent deliveries, newest first. */
  deliveries: z.array(alertDeliverySchema),
});
export type AlertsResponse = z.output<typeof alertsResponseSchema>;

const destinationParams = z.object({ projectId: z.uuid(), destinationId: z.uuid() });

const alertsUnavailable = () =>
  new GatewayError(
    'alerts_unavailable',
    'Alerts are off on this gateway (ALERTS_ENABLED, or no ALERTS_ENCRYPTION_KEY or API_KEY_PEPPER).',
    { httpStatus: 409 },
  );

/**
 * Webhook alert destinations and their recent deliveries (M15, ADR 033). Admins add, delete and
 * test destinations; viewers read. URLs are stored encrypted and only ever shown masked; a generic
 * destination's signing secret is returned once, in the response that creates it.
 */
export function registerAlertRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock } = deps;
  const key = deps.alerts?.key ?? null;
  const enabled = deps.alerts?.enabled === true && key !== null;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/admin/projects/:projectId/alerts',
    {
      schema: {
        tags: ['admin'],
        summary: "The project's alert destinations and recent deliveries (viewer)",
        security,
        params: projectParams,
        response: { 200: alertsResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      const destinations = await db
        .selectFrom('alert_destinations')
        .select(['id', 'name', 'kind', 'url_hint', 'events', 'created_at'])
        .where('project_id', '=', projectId)
        .orderBy('name')
        .execute();
      const deliveries = await db
        .selectFrom('alert_deliveries as a')
        .innerJoin('alert_destinations as d', 'd.id', 'a.destination_id')
        .select([
          'a.id',
          'a.destination_id',
          'd.name',
          'a.event_type',
          'a.status',
          'a.attempts',
          'a.last_status',
          'a.last_error',
          'a.created_at',
          'a.delivered_at',
          'a.next_attempt_at',
        ])
        .where('a.project_id', '=', projectId)
        .orderBy('a.created_at', 'desc')
        .limit(50)
        .execute();
      return {
        enabled,
        destinations: destinations.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          urlHint: d.url_hint,
          events: d.events as (typeof ALERT_EVENTS)[number][],
          createdAt: iso(d.created_at),
        })),
        deliveries: deliveries.map((r) => ({
          id: r.id,
          destinationId: r.destination_id,
          destinationName: r.name,
          eventType: r.event_type,
          status: r.status,
          attempts: r.attempts,
          lastStatus: r.last_status,
          lastError: r.last_error,
          createdAt: iso(r.created_at),
          deliveredAt: r.delivered_at ? iso(r.delivered_at) : null,
          nextAttemptAt: r.status === 'pending' ? iso(r.next_attempt_at) : null,
        })),
      };
    },
  );

  routes.post(
    '/admin/projects/:projectId/alerts/destinations',
    {
      schema: {
        tags: ['admin'],
        summary: 'Add an alert destination (admin); a generic one returns its signing secret once',
        description:
          'Discord and Slack destinations take their incoming-webhook URL; `generic` receives ' +
          'JSON signed as Standard Webhooks describes (`webhook-id`, `webhook-timestamp`, ' +
          '`webhook-signature`). Only https URLs; private and metadata addresses are refused when ' +
          'an alert is sent.',
        security,
        params: projectParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(100),
            kind: z.enum(ALERT_KINDS),
            url: z
              .string()
              .trim()
              .max(2_048)
              .refine((u) => {
                try {
                  const parsed = new URL(u);
                  return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
                } catch {
                  return false;
                }
              }, 'must be an https URL without credentials'),
            events: z
              .array(z.enum(ALERT_EVENTS))
              .min(1)
              .max(3)
              .refine((e) => new Set(e).size === e.length, 'lists an event twice'),
          })
          .strict(),
        response: {
          201: z.object({ destination: alertDestinationSchema, secret: z.string().nullable() }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      if (!enabled || !key) throw alertsUnavailable();
      const { name, kind, url, events } = request.body;
      const secret = kind === 'generic' ? newSigningSecret() : null;
      const id = uuidv7(clock.now());
      const created = await db.transaction().execute(async (trx) => {
        const taken = await trx
          .selectFrom('alert_destinations')
          .select('id')
          .where('project_id', '=', projectId)
          .where('name', '=', name)
          .executeTakeFirst();
        if (taken) {
          throw new GatewayError('name_taken', 'A destination with this name exists already.', {
            httpStatus: 409,
            param: 'name',
          });
        }
        const row = await trx
          .insertInto('alert_destinations')
          .values({
            id,
            project_id: projectId,
            name,
            kind,
            url_ciphertext: sealText(key, url),
            url_hint: maskUrl(url),
            secret_ciphertext: secret ? sealText(key, secret) : null,
            events,
            created_by: user.id,
          })
          .returning(['id', 'name', 'kind', 'url_hint', 'events', 'created_at'])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'alert_destination.create',
          targetType: 'alert_destination',
          targetId: id,
          // Never the URL: it holds the receiver's token.
          details: { name, kind, events },
          requestId: request.id,
        });
        return row;
      });
      void reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        destination: {
          id: created.id,
          name: created.name,
          kind: created.kind,
          urlHint: created.url_hint,
          events: created.events as (typeof ALERT_EVENTS)[number][],
          createdAt: iso(created.created_at),
        },
        secret,
      });
    },
  );

  routes.delete(
    '/admin/projects/:projectId/alerts/destinations/:destinationId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete an alert destination and its deliveries (admin)',
        security,
        params: destinationParams,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, destinationId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .deleteFrom('alert_destinations')
          .where('id', '=', destinationId)
          .where('project_id', '=', projectId)
          .returning(['name', 'kind'])
          .executeTakeFirst();
        if (!row) throw destinationNotFound();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'alert_destination.delete',
          targetType: 'alert_destination',
          targetId: destinationId,
          details: { name: row.name, kind: row.kind },
          requestId: request.id,
        });
      });
      return reply.code(204).send(null);
    },
  );

  routes.post(
    '/admin/projects/:projectId/alerts/destinations/:destinationId/test',
    {
      schema: {
        tags: ['admin'],
        summary: 'Queue a test alert to one destination (admin)',
        description:
          'The worker sends it within its poll interval; its delivery shows in the list.',
        security,
        params: destinationParams,
        response: { 202: z.object({ deliveryId: z.string() }), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, destinationId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      if (!enabled) throw alertsUnavailable();
      const destination = await db
        .selectFrom('alert_destinations')
        .innerJoin('projects', 'projects.id', 'alert_destinations.project_id')
        .select(['alert_destinations.id', 'projects.name as projectName'])
        .where('alert_destinations.id', '=', destinationId)
        .where('alert_destinations.project_id', '=', projectId)
        .executeTakeFirst();
      if (!destination) throw destinationNotFound();
      const deliveryId = await db.transaction().execute(async (trx) => {
        const queued = await enqueueTestAlert(
          trx,
          { id: destinationId, projectId },
          { projectId, projectName: destination.projectName },
          clock.now(),
        );
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'alert_destination.test',
          targetType: 'alert_destination',
          targetId: destinationId,
          details: { deliveryId: queued },
          requestId: request.id,
        });
        return queued;
      });
      return reply.code(202).send({ deliveryId });
    },
  );
}

function destinationNotFound(): GatewayError {
  return new GatewayError('alert_destination_not_found', 'Alert destination not found.', {
    httpStatus: 404,
  });
}
