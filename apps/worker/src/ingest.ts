import { costMicroUsd, priceAt, uuidv7, type UsageEvent } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';

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
      events.map(({ request: r, attempts }) => ({
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

  const usageRows = events.flatMap((event) => {
    const attempt = finalAttempt(event);
    // A request rejected before any provider call has no usage to account.
    if (!attempt) return [];
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
        occurred_at: event.occurredAt,
      },
    ];
  });
  if (usageRows.length > 0) {
    // No conflict target: a repeated event_id or request_id is skipped either way.
    await trx
      .insertInto('usage_events')
      .values(usageRows)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}
