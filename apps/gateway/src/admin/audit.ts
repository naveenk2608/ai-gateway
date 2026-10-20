import { uuidv7 } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';

export type Actor = { type: 'user'; userId: string } | { type: 'system' };

export interface AuditEntry {
  projectId: string | null;
  actor: Actor;
  /** `<resource>.<verb>`, e.g. `api_key.revoke`. */
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Never secrets: no plaintext keys, hashes or passwords. */
  details?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Writes one audit row. Callers pass the transaction that makes the change, so the change and its
 * audit row commit or roll back together.
 */
export async function writeAudit(trx: Db, entry: AuditEntry): Promise<void> {
  await trx
    .insertInto('audit_logs')
    .values({
      id: uuidv7(),
      project_id: entry.projectId,
      actor_type: entry.actor.type,
      actor_user_id: entry.actor.type === 'user' ? entry.actor.userId : null,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      details: JSON.stringify(entry.details ?? {}),
      request_id: entry.requestId ?? null,
    })
    .execute();
}
