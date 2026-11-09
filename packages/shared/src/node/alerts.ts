import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { sql } from 'kysely';
import { uuidv7 } from '../ids.js';
import type { Db } from './db.js';

/** What a destination can subscribe to (M15, ADR 033). */
export const ALERT_EVENTS = ['budget', 'breaker', 'dead_letters'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export const ALERT_KINDS = ['discord', 'slack', 'generic'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** The `event_type` of a delivery: one per event, plus the dashboard's "send test". */
export type AlertEventType =
  'budget.threshold' | 'breaker.opened' | 'dead_letters.growing' | 'test';

const EVENT_OF: Record<Exclude<AlertEventType, 'test'>, AlertEvent> = {
  'budget.threshold': 'budget',
  'breaker.opened': 'breaker',
  'dead_letters.growing': 'dead_letters',
};

/** HKDF `info` for the key derived from API_KEY_PEPPER: its own label, used for nothing else. */
const KEY_LABEL = 'ai-gateway alert destinations v1';

/**
 * The AES-256 key for destination URLs and signing secrets: ALERTS_ENCRYPTION_KEY (32 bytes,
 * base64) when set, else HKDF-SHA256 over API_KEY_PEPPER with its own label, so no new setting is
 * needed. Changing the pepper (or the key) makes stored URLs unreadable: enter them again.
 */
export function alertsKey(settings: {
  ALERTS_ENCRYPTION_KEY?: string | undefined;
  API_KEY_PEPPER?: string | undefined;
}): Buffer | null {
  if (settings.ALERTS_ENCRYPTION_KEY) {
    const key = Buffer.from(settings.ALERTS_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('ALERTS_ENCRYPTION_KEY must be 32 bytes, base64');
    return key;
  }
  if (!settings.API_KEY_PEPPER) return null;
  return Buffer.from(hkdfSync('sha256', settings.API_KEY_PEPPER, Buffer.alloc(0), KEY_LABEL, 32));
}

/** AES-256-GCM: a random 12-byte nonce, the ciphertext and the 16-byte tag, in one buffer. */
export function sealText(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** Opens what `sealText` made; throws if the key is wrong or the data was changed. */
export function openText(key: Buffer, sealed: Buffer): string {
  if (sealed.length < 28) throw new Error('sealed text is too short');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * A generic destination's signing secret, in the Standard Webhooks form: `whsec_` and 32 random
 * bytes in base64 (the spec allows 24 to 64 bytes).
 */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

/**
 * The Standard Webhooks signature header value: `v1,` and the base64 HMAC-SHA256 of
 * `<id>.<timestamp>.<body>`, keyed with the secret's bytes (the base64 after `whsec_`).
 */
export function webhookSignature(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

/**
 * Checks a delivery as a receiver would (the README's recipe): a `v1` signature among the
 * space-separated ones that matches, and a timestamp within `toleranceSeconds` of `nowSeconds`.
 */
export function verifyWebhook(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = Buffer.from(webhookSignature(secret, headers.id, timestamp, body));
  return headers.signature.split(' ').some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** A masked URL for the dashboard: the scheme and host, and the last 4 characters. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…${url.slice(-4)}`;
  } catch {
    return '…';
  }
}

export interface EnqueueAlert {
  /** A budget event goes to this project's destinations; null: every project's that chose it. */
  projectId: string | null;
  type: Exclude<AlertEventType, 'test'>;
  /** Unique per destination: the same event is queued once (e.g. a threshold per month). */
  dedupeKey: string;
  /** The facts the message is made from; never prompts, keys or URLs. */
  payload: Record<string, unknown>;
  occurredAt: number;
}

/**
 * Queues an event for every destination that chose it (ADR 033), in the caller's transaction when
 * it has one: one outbox row per destination, deduplicated. Returns the rows added.
 */
export async function enqueueAlert(db: Db, alert: EnqueueAlert): Promise<number> {
  let query = db
    .selectFrom('alert_destinations')
    .select(['id', 'project_id'])
    .where(sql<boolean>`${EVENT_OF[alert.type]} = ANY (events)`);
  if (alert.projectId !== null) query = query.where('project_id', '=', alert.projectId);
  const destinations = await query.execute();
  if (destinations.length === 0) return 0;
  const payload = JSON.stringify({
    type: alert.type,
    timestamp: new Date(alert.occurredAt).toISOString(),
    data: alert.payload,
  });
  const inserted = await db
    .insertInto('alert_deliveries')
    .values(
      destinations.map((d) => ({
        id: uuidv7(alert.occurredAt),
        destination_id: d.id,
        project_id: d.project_id,
        event_type: alert.type,
        dedupe_key: alert.dedupeKey,
        payload,
      })),
    )
    .onConflict((oc) => oc.constraint('alert_deliveries_dedupe').doNothing())
    .returning('id')
    .execute();
  return inserted.length;
}

/** Queues a test message for one destination (the dashboard's "send test"). */
export async function enqueueTestAlert(
  db: Db,
  destination: { id: string; projectId: string },
  data: Record<string, unknown>,
  now: number,
): Promise<string> {
  const id = uuidv7(now);
  await db
    .insertInto('alert_deliveries')
    .values({
      id,
      destination_id: destination.id,
      project_id: destination.projectId,
      event_type: 'test',
      dedupe_key: `test:${id}`,
      payload: JSON.stringify({ type: 'test', timestamp: new Date(now).toISOString(), data }),
    })
    .execute();
  return id;
}
