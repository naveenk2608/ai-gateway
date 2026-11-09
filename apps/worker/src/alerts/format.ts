import { webhookSignature, type AlertKind } from '@ai-gateway/shared/node';

/** What the outbox holds: the Standard Webhooks payload shape (type, timestamp, data). */
export interface AlertPayload {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const usd = (micro: unknown) => `$${(Number(micro) / 1_000_000).toFixed(2)}`;
const text = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

/** The one-line message Discord and Slack show. */
export function messageText(payload: AlertPayload): string {
  const d = payload.data;
  switch (payload.type) {
    case 'budget.threshold':
      return (
        `AI Gateway: project "${text(d.projectName)}" has used ${text(d.thresholdPct)}% of its ` +
        `monthly budget for ${text(d.period)} (${usd(d.spentMicroUsd)} of ${usd(d.limitMicroUsd)}).`
      );
    case 'breaker.opened':
      return (
        `AI Gateway: the circuit breaker of deployment "${text(d.deployment)}" opened; ` +
        'requests skip it until a health check or a trial request succeeds.'
      );
    case 'dead_letters.growing':
      return (
        `AI Gateway: ${text(d.count)} usage event(s) were moved to the dead-letter queue in the ` +
        `last ${text(d.windowMinutes)} minutes; their requests are missing from the records.`
      );
    case 'test':
      return `AI Gateway: test alert for project "${text(d.projectName)}".`;
    default:
      return `AI Gateway: ${payload.type}.`;
  }
}

/** Slack's documented escapes for `&`, `<` and `>` in message text. */
const slackEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The body and headers for a destination's kind (ADR 033):
 * - Discord's Execute Webhook: `content` (at most 2,000 characters) with every mention disabled
 *   (`allowed_mentions: {"parse": []}`);
 * - Slack's incoming webhook: `text`;
 * - generic: the payload as JSON, signed as Standard Webhooks describes (`webhook-id`,
 *   `webhook-timestamp` in Unix seconds, `webhook-signature: v1,<base64 HMAC-SHA256 of
 *   id.timestamp.body>`).
 */
export function renderDelivery(
  kind: AlertKind,
  delivery: { id: string; payload: AlertPayload },
  secret: string | null,
  nowMs: number,
): { body: string; headers: Record<string, string> } {
  if (kind === 'discord') {
    const content = messageText(delivery.payload).slice(0, 2_000);
    return { body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), headers: {} };
  }
  if (kind === 'slack') {
    return {
      body: JSON.stringify({ text: slackEscape(messageText(delivery.payload)) }),
      headers: {},
    };
  }
  if (!secret) throw new Error('a generic destination has no signing secret');
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(nowMs / 1000);
  return {
    body,
    headers: {
      'webhook-id': delivery.id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': webhookSignature(secret, delivery.id, timestamp, body),
    },
  };
}
