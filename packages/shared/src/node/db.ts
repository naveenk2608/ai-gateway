import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import type pg from 'pg';

/**
 * Table types for Kysely (ADR 003), kept in step with db/migrations by hand. `Generated` marks
 * columns with a database default; timestamps come back as Date, bigint as number (see
 * createPgPool), bytea as Buffer.
 */

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;
type JsonWithDefault = ColumnType<unknown, string | undefined, string>;

export type Role = 'owner' | 'admin' | 'viewer';
export type UsageSource = 'reported' | 'estimated' | 'missing';
export type RequestStatus = 'success' | 'error' | 'canceled' | 'rejected';

export interface UsersTable {
  id: string;
  email: string;
  password_hash: string;
  created_at: CreatedAt;
  disabled_at: Timestamp | null;
}

export interface UserSessionsTable {
  id: string;
  user_id: string;
  token_hash: Buffer;
  created_at: CreatedAt;
  expires_at: Timestamp;
}

export interface ProjectsTable {
  id: string;
  name: string;
  allowed_models: string[] | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  concurrency_limit: number | null;
  monthly_budget_micro_usd: number | null;
  max_request_cost_micro_usd: number | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ProjectMembersTable {
  project_id: string;
  user_id: string;
  role: Role;
  created_at: CreatedAt;
}

export interface ApiKeysTable {
  id: string;
  project_id: string;
  key_id: string;
  secret_hash: Buffer;
  name: string;
  created_by: string | null;
  created_at: CreatedAt;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  rotated_to: string | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  concurrency_limit: number | null;
}

export interface ModelDeploymentsTable {
  id: string;
  name: string;
  provider: 'mock' | 'ollama' | 'openai-compatible';
  provider_model: string;
  base_url: string | null;
  settings: JsonWithDefault;
  enabled: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface RoutingPoliciesTable {
  id: string;
  project_id: string | null;
  model: string;
  strategy: 'priority' | 'weighted' | 'lowest_latency' | 'cost_aware';
  targets: Json;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ModelPricesTable {
  id: string;
  provider: string;
  model: string;
  input_micro_usd_per_mtok: number;
  output_micro_usd_per_mtok: number;
  effective_from: Timestamp;
  created_at: CreatedAt;
}

export interface RequestRecordsTable {
  id: string;
  project_id: string;
  api_key_id: string | null;
  model: string;
  deployment: string | null;
  stream: boolean;
  status: RequestStatus;
  http_status: number;
  error_code: string | null;
  attempt_count: number;
  started_at: Timestamp;
  completed_at: Timestamp;
  latency_ms: number;
  ttft_ms: number | null;
  created_at: CreatedAt;
}

export interface ProviderAttemptsTable {
  id: string;
  request_id: string;
  attempt_number: number;
  deployment: string;
  provider: string;
  provider_model: string;
  routing_policy: string | null;
  routing_reason: string | null;
  outcome: string;
  upstream_status: number | null;
  started_at: Timestamp;
  completed_at: Timestamp;
  latency_ms: number;
  ttft_ms: number | null;
}

export interface UsageEventsTable {
  id: string;
  event_id: string;
  request_id: string;
  project_id: string;
  api_key_id: string | null;
  deployment: string | null;
  provider: string | null;
  provider_model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  usage_source: UsageSource;
  cost_micro_usd: number | null;
  price_id: string | null;
  estimated_prompt_tokens: number | null;
  occurred_at: Timestamp;
  ingested_at: CreatedAt;
}

export interface BudgetPeriodsTable {
  id: string;
  project_id: string;
  period_start: Timestamp;
  period_end: Timestamp;
  limit_micro_usd: number | null;
  spent_micro_usd: Generated<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface BudgetReservationsTable {
  id: string;
  budget_period_id: string;
  project_id: string;
  request_id: string;
  reserved_micro_usd: number;
  actual_micro_usd: number | null;
  status: 'reserved' | 'reconciled' | 'expired';
  created_at: CreatedAt;
  settled_at: Timestamp | null;
}

export interface ProviderHealthEventsTable {
  id: string;
  deployment: string;
  instance_id: string;
  from_state: 'closed' | 'open' | 'half_open' | null;
  to_state: 'closed' | 'open' | 'half_open';
  reason: string | null;
  occurred_at: Timestamp;
}

export interface AuditLogsTable {
  id: string;
  project_id: string | null;
  actor_type: 'user' | 'system';
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  details: JsonWithDefault;
  request_id: string | null;
  created_at: CreatedAt;
}

export interface FailedEventsTable {
  id: string;
  stream: string;
  stream_message_id: string;
  event_id: string | null;
  payload: string;
  error: string;
  delivery_count: number;
  failed_at: CreatedAt;
}

export interface Database {
  users: UsersTable;
  user_sessions: UserSessionsTable;
  projects: ProjectsTable;
  project_members: ProjectMembersTable;
  api_keys: ApiKeysTable;
  model_deployments: ModelDeploymentsTable;
  routing_policies: RoutingPoliciesTable;
  model_prices: ModelPricesTable;
  request_records: RequestRecordsTable;
  provider_attempts: ProviderAttemptsTable;
  usage_events: UsageEventsTable;
  budget_periods: BudgetPeriodsTable;
  budget_reservations: BudgetReservationsTable;
  provider_health_events: ProviderHealthEventsTable;
  audit_logs: AuditLogsTable;
  failed_events: FailedEventsTable;
}

export type Db = Kysely<Database>;

/** A Kysely instance over an existing pool. Destroying it ends the pool. */
export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
