import { ANALYTICS_RANGES, rangeWindow } from '@ai-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { guardrailPolicySchema, parseGuardrailPolicy } from '../guardrails/policy.js';
import { currentUser, requireProjectRole } from './access.js';
import { writeAudit } from './audit.js';
import { errorResponses, iso, projectParams, type AdminDeps } from './schemas.js';

const security = [{ session: [] }];

const policyResponse = z.object({
  /** False when GUARDRAILS_ENABLED is off: no project's checks run. */
  enabled: z.boolean(),
  policy: guardrailPolicySchema,
});

const ACTIONS = ['mask', 'block', 'flag', 'retry', 'fail', 'none'] as const;

export const guardrailResultsSchema = z.object({
  data: z.array(
    z.object({
      requestId: z.string(),
      createdAt: z.string(),
      model: z.string().nullable(),
      status: z.string().nullable(),
      stage: z.enum(['input', 'output']),
      /** A detector type, blocked_terms, prompt_size, schema or image. Never a value. */
      check: z.string(),
      findings: z.number(),
      action: z.enum(ACTIONS),
    }),
  ),
});
export type GuardrailResultsResponse = z.output<typeof guardrailResultsSchema>;

export const guardrailSummarySchema = z.object({
  range: z.enum(ANALYTICS_RANGES),
  /** Requests with at least one finding of each action in the range. */
  requests: z.object({ blocked: z.number(), flagged: z.number(), masked: z.number() }),
});
export type GuardrailSummaryResponse = z.output<typeof guardrailSummarySchema>;

/**
 * Guardrails (M16, ADR 035): a project's policy, read by viewers and set by admins (audited, and
 * applied on every instance through the key cache's invalidation), and what the checks found:
 * the flagged and blocked requests, and their counts for the Overview page.
 */
export function registerGuardrailRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock } = deps;
  const enabled = deps.guardrailsEnabled === true;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/admin/projects/:projectId/guardrails',
    {
      schema: {
        tags: ['admin'],
        summary: "The project's guardrail policy (viewer)",
        security,
        params: projectParams,
        response: { 200: policyResponse, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      const row = await db
        .selectFrom('projects')
        .select('guardrails')
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow();
      return { enabled, policy: parseGuardrailPolicy(row.guardrails) };
    },
  );

  routes.put(
    '/admin/projects/:projectId/guardrails',
    {
      schema: {
        tags: ['admin'],
        summary: "Set the project's guardrail policy (admin)",
        description:
          'Detectors (email, phone, card, Aadhaar, PAN) before the model: off, mask, block or ' +
          'flag; after it: off, mask or flag. Blocked words and phrases, a prompt cap, and JSON ' +
          'schema checks (flag, or retry once then 502). Fields left out are off.',
        security,
        params: projectParams,
        body: guardrailPolicySchema,
        response: { 200: policyResponse, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      const policy = request.body;
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('projects')
          .set({ guardrails: JSON.stringify(policy), updated_at: new Date(clock.now()) })
          .where('id', '=', projectId)
          .execute();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'project.guardrails',
          targetType: 'project',
          targetId: projectId,
          // The policy holds no secrets; blocked terms are counted, not copied.
          details: {
            input: policy.input,
            output: policy.output,
            blockedTerms: {
              count: policy.blockedTerms.terms.length,
              action: policy.blockedTerms.action,
            },
            maxPromptTokens: policy.maxPromptTokens,
          },
          requestId: request.id,
        });
      });
      // Cached keys carry the policy: every instance reads it again.
      await deps.invalidation.publish({ kind: 'project', projectId });
      return { enabled, policy };
    },
  );

  routes.get(
    '/admin/projects/:projectId/guardrails/results',
    {
      schema: {
        tags: ['admin'],
        summary: 'Requests whose guardrail checks found something, newest first (viewer)',
        description: 'Types, counts and actions only; never the values found.',
        security,
        params: projectParams,
        querystring: z
          .object({
            range: z.enum(ANALYTICS_RANGES).default('24h'),
            action: z.enum(ACTIONS).optional(),
            stage: z.enum(['input', 'output']).optional(),
            check: z.string().min(1).max(40).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(100),
          })
          .strict(),
        response: { 200: guardrailResultsSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const { range, action, stage, check, limit } = request.query;
      await requireProjectRole(db, request, projectId, 'viewer');
      const window = rangeWindow(range, clock.now());
      let query = db
        .selectFrom('guardrail_results as g')
        .leftJoin('request_records as r', 'r.id', 'g.request_id')
        .select([
          'g.request_id',
          'g.created_at',
          'r.model',
          'r.status',
          'g.stage',
          'g.check',
          'g.findings',
          'g.action',
        ])
        .where('g.project_id', '=', projectId)
        .where('g.created_at', '>=', new Date(window.from))
        .where('g.created_at', '<', new Date(window.to))
        // An image is noted, not a finding.
        .where('g.check', '!=', 'image')
        .orderBy('g.created_at', 'desc')
        .limit(limit);
      if (action) query = query.where('g.action', '=', action);
      if (stage) query = query.where('g.stage', '=', stage);
      if (check) query = query.where('g.check', '=', check);
      const rows = await query.execute();
      return {
        data: rows.map((r) => ({
          requestId: r.request_id,
          createdAt: iso(r.created_at),
          model: r.model ?? null,
          status: r.status ?? null,
          stage: r.stage,
          check: r.check,
          findings: r.findings,
          action: r.action,
        })),
      };
    },
  );

  routes.get(
    '/admin/projects/:projectId/guardrails/summary',
    {
      schema: {
        tags: ['admin'],
        summary: 'How many requests the guardrails blocked, flagged and masked (viewer)',
        security,
        params: projectParams,
        querystring: z.object({ range: z.enum(ANALYTICS_RANGES).default('24h') }).strict(),
        response: { 200: guardrailSummarySchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const { range } = request.query;
      await requireProjectRole(db, request, projectId, 'viewer');
      const window = rangeWindow(range, clock.now());
      const row = await sql<{ blocked: string; flagged: string; masked: string }>`
        SELECT count(DISTINCT request_id) FILTER (WHERE action IN ('block', 'fail')) AS blocked,
               count(DISTINCT request_id) FILTER (WHERE action IN ('flag', 'retry')) AS flagged,
               count(DISTINCT request_id) FILTER (WHERE action = 'mask') AS masked
          FROM guardrail_results
         WHERE project_id = ${projectId}
           AND created_at >= ${new Date(window.from)}
           AND created_at < ${new Date(window.to)}`.execute(db);
      const counts = row.rows[0];
      return {
        range,
        requests: {
          blocked: Number(counts?.blocked ?? 0),
          flagged: Number(counts?.flagged ?? 0),
          masked: Number(counts?.masked ?? 0),
        },
      };
    },
  );
}
