import { z } from 'zod';

/** Redis Stream names and consumer group for usage events (ADR 005, ADR 014). */
export const USAGE_STREAM = 'gw:events:usage';
export const USAGE_DLQ_STREAM = 'gw:events:usage:dlq';
export const USAGE_CONSUMER_GROUP = 'usage-workers';

const isoDate = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);

export const attemptRecordSchema = z.object({
  /** The attemptId in the gateway logs. */
  id: z.uuid(),
  attemptNumber: z.number().int().min(1),
  deployment: z.string().min(1),
  provider: z.string().min(1),
  providerModel: z.string().min(1),
  /** 'success', a ProviderError kind ('timeout', 'rate_limited', ...) or 'error'. */
  outcome: z.string().min(1),
  upstreamStatus: z.number().int().nullable(),
  /** Set by the routing policies (M5). */
  routingPolicy: z.string().nullable(),
  routingReason: z.string().nullable(),
  startedAt: isoDate,
  completedAt: isoDate,
  latencyMs: count,
  ttftMs: count.nullable(),
});

export const usageSourceSchema = z.enum(['reported', 'estimated', 'missing']);

/**
 * One event per logical request, emitted by the gateway when the request ends. `eventId` makes
 * re-deliveries harmless: the worker inserts with ON CONFLICT DO NOTHING (ADR 014). The event
 * carries counts and timings only, never prompts or completions.
 */
export const usageEventSchema = z.object({
  v: z.literal(1),
  type: z.literal('request.completed'),
  eventId: z.uuid(),
  occurredAt: isoDate,
  request: z.object({
    id: z.uuid(),
    projectId: z.uuid(),
    apiKeyId: z.uuid().nullable(),
    model: z.string().min(1).max(256),
    deployment: z.string().nullable(),
    stream: z.boolean(),
    status: z.enum(['success', 'error', 'canceled', 'rejected']),
    httpStatus: z.number().int().min(100).max(599),
    errorCode: z.string().nullable(),
    startedAt: isoDate,
    completedAt: isoDate,
    latencyMs: count,
    ttftMs: count.nullable(),
  }),
  attempts: z.array(attemptRecordSchema).max(20),
  /** Tokens for the request; null when unknown (`usageSource: 'missing'`). */
  usage: z.object({ promptTokens: count, completionTokens: count, totalTokens: count }).nullable(),
  usageSource: usageSourceSchema,
  /** The gateway's prompt-token estimate, made before the call (M4); compare with reported usage. */
  estimatedPromptTokens: count.optional(),
  /**
   * Set when the project had a budget (ADR 009): the monthly limit and the worst-case cost
   * reserved before the call. The worker audits it as a budget reservation.
   */
  budget: z.object({ limitMicroUsd: count, reservedMicroUsd: count }).optional(),
  /** Answered from the response cache (ADR 013): no attempts, and the usage costs nothing. */
  cacheHit: z.boolean().optional(),
});

export type UsageEvent = z.output<typeof usageEventSchema>;
export type AttemptRecord = z.output<typeof attemptRecordSchema>;
export type UsageSourceValue = z.output<typeof usageSourceSchema>;
