import {
  budgetPeriodAt,
  costMicroUsd,
  priceAt,
  uuidv7,
  type BudgetPeriod,
  type UsageEvent,
} from '@ai-gateway/shared';
import type { Database, Db } from '@ai-gateway/shared/node';
import type { Insertable } from 'kysely';

interface Price {
  id: string;
  provider: string;
  model: string;
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  effectiveFrom: number;
}

/** The attempt that produced the response (or the last one tried). */
function finalAttempt(event: UsageEvent) {
  return event.attempts.reduce<UsageEvent['attempts'][number] | undefined>(
    (last, a) => (!last || a.attemptNumber > last.attemptNumber ? a : last),
    undefined,
  );
}

const pairKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/** Every price version for the models in the batch, up to the latest request time. */
async function loadPrices(trx: Db, events: UsageEvent[]): Promise<Map<string, Price[]>> {
  const pairs = new Map<string, [string, string]>();
  let latest = 0;
  for (const event of events) {
    const attempt = finalAttempt(event);
    if (!attempt || !event.usage) continue;
    pairs.set(pairKey(attempt.provider, attempt.providerModel), [
      attempt.provider,
      attempt.providerModel,
    ]);
    latest = Math.max(latest, Date.parse(event.request.startedAt));
  }
  const byPair = new Map<string, Price[]>();
  if (pairs.size === 0) return byPair;
  const rows = await trx
    .selectFrom('model_prices')
    .selectAll()
    .where('effective_from', '<=', new Date(latest))
    .where((eb) =>
      eb.or(
        [...pairs.values()].map(([provider, model]) =>
          eb.and([eb('provider', '=', provider), eb('model', '=', model)]),
        ),
      ),
    )
    .execute();
  for (const row of rows) {
    const key = pairKey(row.provider, row.model);
    const list = byPair.get(key) ?? [];
    list.push({
      id: row.id,
      provider: row.provider,
      model: row.model,
      inputMicroUsdPerMTok: row.input_micro_usd_per_mtok,
      outputMicroUsdPerMTok: row.output_micro_usd_per_mtok,
      effectiveFrom: row.effective_from.getTime(),
    });
    byPair.set(key, list);
  }
  return byPair;
}

/**
 * Writes a batch of events: one request record, its attempts and (if any provider was called) one
 * usage row each. Every insert is ON CONFLICT DO NOTHING, so re-delivered events change nothing
 * (ADR 014). Cost uses the price version in effect when the request started (ADR 016), and is
 * stored with that version's id, so later price changes never alter it.
 */
export async function ingestEvents(trx: Db, events: UsageEvent[]): Promise<void> {
  if (events.length === 0) return;
  const prices = await loadPrices(trx, events);

  await trx
    .insertInto('request_records')
    .values(
      events.map(({ request: r, attempts, ...event }) => ({
        id: r.id,
        project_id: r.projectId,
        api_key_id: r.apiKeyId,
        model: r.model,
        deployment: r.deployment,
        stream: r.stream,
        status: r.status,
        http_status: r.httpStatus,
        error_code: r.errorCode,
        attempt_count: attempts.length,
        started_at: r.startedAt,
        completed_at: r.completedAt,
        latency_ms: r.latencyMs,
        ttft_ms: r.ttftMs,
        cache_hit: event.cacheHit === true,
      })),
    )
    .onConflict((oc) => oc.doNothing())
    .execute();
  const attempts = events.flatMap((event) =>
    event.attempts.map((a) => ({
      id: a.id,
      request_id: event.request.id,
      attempt_number: a.attemptNumber,
      deployment: a.deployment,
      provider: a.provider,
      provider_model: a.providerModel,
      routing_policy: a.routingPolicy,
      routing_reason: a.routingReason,
      outcome: a.outcome,
      upstream_status: a.upstreamStatus,
      started_at: a.startedAt,
      completed_at: a.completedAt,
      latency_ms: a.latencyMs,
      ttft_ms: a.ttftMs,
    })),
  );
  if (attempts.length > 0) {
    await trx
      .insertInto('provider_attempts')
      .values(attempts)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  const usageRows = events.flatMap((event): Insertable<Database['usage_events']>[] => {
    const attempt = finalAttempt(event);
    if (!attempt) {
      // A cache hit used no provider: its tokens are recorded, at no cost (ADR 013). A request
      // rejected before any provider call has no usage to account.
      if (!event.cacheHit) return [];
      return [
        {
          id: uuidv7(Date.parse(event.occurredAt)),
          event_id: event.eventId,
          request_id: event.request.id,
          project_id: event.request.projectId,
          api_key_id: event.request.apiKeyId,
          deployment: null,
          provider: null,
          provider_model: null,
          prompt_tokens: event.usage?.promptTokens ?? null,
          completion_tokens: event.usage?.completionTokens ?? null,
          total_tokens: event.usage?.totalTokens ?? null,
          usage_source: event.usageSource,
          cost_micro_usd: 0,
          price_id: null,
          estimated_prompt_tokens: event.estimatedPromptTokens ?? null,
          occurred_at: event.occurredAt,
        },
      ];
    }
    const usage = event.usage;
    const price = usage
      ? priceAt(
          prices.get(pairKey(attempt.provider, attempt.providerModel)) ?? [],
          Date.parse(event.request.startedAt),
        )
      : undefined;
    const cost =
      usage && price ? costMicroUsd(usage.promptTokens, usage.completionTokens, price) : null;
    return [
      {
        id: uuidv7(Date.parse(event.occurredAt)),
        event_id: event.eventId,
        request_id: event.request.id,
        project_id: event.request.projectId,
        api_key_id: event.request.apiKeyId,
        deployment: attempt.deployment,
        provider: attempt.provider,
        provider_model: attempt.providerModel,
        prompt_tokens: usage?.promptTokens ?? null,
        completion_tokens: usage?.completionTokens ?? null,
        total_tokens: usage?.totalTokens ?? null,
        usage_source: event.usageSource,
        cost_micro_usd: cost,
        price_id: cost === null ? null : (price?.id ?? null),
        estimated_prompt_tokens: event.estimatedPromptTokens ?? null,
        occurred_at: event.occurredAt,
      },
    ];
  });
  // No conflict target: a repeated event_id or request_id is skipped either way. RETURNING lists
  // only the rows inserted now, so a re-delivered event adds nothing to the spend below.
  const inserted =
    usageRows.length === 0
      ? []
      : await trx
          .insertInto('usage_events')
          .values(usageRows)
          .onConflict((oc) => oc.doNothing())
          .returning('request_id')
          .execute();
  const costs = new Map(usageRows.map((row) => [row.request_id, row.cost_micro_usd ?? null]));
  await updateBudgetLedger(trx, events, costs, new Set(inserted.map((row) => row.request_id)));
}

interface PeriodDelta {
  projectId: string;
  period: BudgetPeriod;
  spent: number;
  limit: number | null;
}

/**
 * Keeps each project's monthly spend in `budget_periods` (ADR 009), the total the gateway rebuilds
 * its Redis budget from, and audits the reservation of each request that had a budget. Spend grows
 * only by usage rows this transaction inserted, so it counts each request once.
 */
async function updateBudgetLedger(
  trx: Db,
  events: UsageEvent[],
  costs: Map<string, number | null>,
  inserted: Set<string>,
): Promise<void> {
  const deltas = new Map<string, PeriodDelta>();
  const periodOf = (event: UsageEvent) => budgetPeriodAt(Date.parse(event.request.startedAt));
  const touch = (event: UsageEvent, spent: number) => {
    const period = periodOf(event);
    const key = `${event.request.projectId}|${period.key}`;
    const delta = deltas.get(key) ?? {
      projectId: event.request.projectId,
      period,
      spent: 0,
      limit: null,
    };
    delta.spent += spent;
    if (event.budget) delta.limit = event.budget.limitMicroUsd;
    deltas.set(key, delta);
  };
  // One event per request: the same event can arrive more than once in a batch.
  const unique = [...new Map(events.map((e) => [e.request.id, e])).values()];
  for (const event of unique) {
    const cost = inserted.has(event.request.id) ? (costs.get(event.request.id) ?? 0) : 0;
    if (cost > 0 || event.budget) touch(event, cost);
  }
  if (deltas.size === 0) return;

  // A fixed order, so concurrent workers lock the same rows in the same order (no deadlocks).
  const rows = [...deltas.values()].sort(
    (a, b) => a.projectId.localeCompare(b.projectId) || a.period.start - b.period.start,
  );
  const periods = await trx
    .insertInto('budget_periods')
    .values(
      rows.map((d) => ({
        id: uuidv7(),
        project_id: d.projectId,
        period_start: new Date(d.period.start),
        period_end: new Date(d.period.end),
        limit_micro_usd: d.limit,
        spent_micro_usd: d.spent,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['project_id', 'period_start']).doUpdateSet((eb) => ({
        spent_micro_usd: eb(
          'budget_periods.spent_micro_usd',
          '+',
          eb.ref('excluded.spent_micro_usd'),
        ),
        limit_micro_usd: eb.fn.coalesce(
          'excluded.limit_micro_usd',
          'budget_periods.limit_micro_usd',
        ),
        updated_at: new Date(),
      })),
    )
    .returning(['id', 'project_id', 'period_start'])
    .execute();
  const periodIds = new Map(
    periods.map((p) => [`${p.project_id}|${p.period_start.getTime()}`, p.id]),
  );

  const reservations = unique.flatMap((event) => {
    if (!event.budget) return [];
    const periodId = periodIds.get(`${event.request.projectId}|${periodOf(event).start}`);
    if (!periodId) return [];
    return [
      {
        id: uuidv7(Date.parse(event.request.startedAt)),
        budget_period_id: periodId,
        project_id: event.request.projectId,
        request_id: event.request.id,
        reserved_micro_usd: event.budget.reservedMicroUsd,
        actual_micro_usd: costs.get(event.request.id) ?? null,
        status: 'reconciled' as const,
        created_at: event.request.startedAt,
        settled_at: event.request.completedAt,
      },
    ];
  });
  if (reservations.length === 0) return;
  // A reservation the gateway's sweeper already recorded as expired (the request outlived its
  // lease) is reconciled now that its cost is known.
  await trx
    .insertInto('budget_reservations')
    .values(reservations)
    .onConflict((oc) =>
      oc
        .column('request_id')
        .doUpdateSet((eb) => ({
          status: 'reconciled',
          actual_micro_usd: eb.ref('excluded.actual_micro_usd'),
          settled_at: eb.ref('excluded.settled_at'),
        }))
        .where('budget_reservations.status', '=', 'expired'),
    )
    .execute();
}
