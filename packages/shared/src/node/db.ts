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
  /** From this share of the monthly budget (percent), routing goes cheapest first. */
  budget_soft_threshold_pct: Generated<number>;
  /** The project's guardrail policy (M16, migration 0016); `{}` means no checks. */
  guardrails: JsonWithDefault;
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
  /** A paid model no deployment calls, for the cost comparison only; never prices a request. */
  reference: Generated<boolean>;
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
  cache_hit: Generated<boolean>;
  /** Answered by an identical request's upstream call (M14, migration 0012). */
  coalesced: Generated<boolean>;
  /** Answered with the stored answer of an earlier request with its Idempotency-Key (M15, 0013). */
  replayed: Generated<boolean>;
  /** The /v1 endpoint the request came to (migration 0010); `chat` for every older row. */
  endpoint: Generated<RequestEndpoint>;
  created_at: CreatedAt;
}

export type RequestEndpoint = 'chat' | 'embeddings';

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
  /** List cost: tokens at the model's price (ADR 016); null without a price or usage. */
  cost_micro_usd: number | null;
  /** What the provider bills (ADR 024): 0 on a free tier, the list cost on a paid one. */
  billed_cost_micro_usd: number | null;
  /** The deployment's billing when the request ran; null for cache hits and rows before M11. */
  billing: 'free_tier' | 'paid' | null;
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

/** An Idempotency-Key and the answer it replays (M15, migration 0013, ADR 032). */
export interface IdempotencyKeysTable {
  id: string;
  project_id: string;
  endpoint: RequestEndpoint;
  idempotency_key: string;
  fingerprint: string;
  status: 'in_progress' | 'completed';
  request_id: string;
  owner: string;
  locked_until: Timestamp;
  response_status: number | null;
  response_headers: Json | null;
  response: Json | null;
  response_bytes: number | null;
  created_at: CreatedAt;
  completed_at: Timestamp | null;
  expires_at: Timestamp;
}

/** A webhook alert destination (M15, migration 0014, ADR 033); URL and secret encrypted. */
export interface AlertDestinationsTable {
  id: string;
  project_id: string;
  name: string;
  kind: 'discord' | 'slack' | 'generic';
  url_ciphertext: Buffer;
  url_hint: string;
  secret_ciphertext: Buffer | null;
  events: string[];
  created_by: string | null;
  created_at: CreatedAt;
}

/** The alert outbox (M15, migration 0014): one row per event and destination. */
export interface AlertDeliveriesTable {
  id: string;
  destination_id: string;
  project_id: string;
  event_type: 'budget.threshold' | 'breaker.opened' | 'dead_letters.growing' | 'test';
  dedupe_key: string;
  payload: Json;
  status: Generated<'pending' | 'delivered' | 'failed'>;
  attempts: Generated<number>;
  next_attempt_at: ColumnType<Date, Date | string | undefined, Date | string>;
  last_status: number | null;
  last_error: string | null;
  created_at: CreatedAt;
  delivered_at: Timestamp | null;
}

/** A version of a project's route override (M15, migration 0015, ADR 034). */
export interface RouteOverridesTable {
  id: string;
  project_id: string;
  model: string;
  version: number;
  action: 'change' | 'rollback' | 'reset';
  route: Json | null;
  rolled_back_to: number | null;
  created_by: string | null;
  created_at: CreatedAt;
}

/** What one request's guardrail checks found and did (M16, migration 0016): never values. */
export interface GuardrailResultsTable {
  id: string;
  request_id: string;
  project_id: string;
  stage: 'input' | 'output';
  check: string;
  findings: number;
  action: 'mask' | 'block' | 'flag' | 'retry' | 'fail' | 'none';
  created_at: Timestamp;
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

/** One row of usage_rollups_minute, _hour or _day (ADR 015); sums over its bucket and key. */
export interface UsageRollupsTable {
  bucket_start: Timestamp;
  project_id: string;
  api_key_id: string | null;
  model: string;
  deployment: string | null;
  provider: string | null;
  status: RequestStatus;
  error_code: string | null;
  requests: number;
  cache_hits: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_micro_usd: number;
  attempts: number;
  retries: number;
  fallbacks: number;
  latency_ms_sum: number;
  latency_buckets: number[];
  ttft_count: number;
  ttft_ms_sum: number;
  ttft_buckets: number[];
  throughput_tokens: number;
  throughput_ms: number;
  /** Billed cost (ADR 024); list cost is cost_micro_usd. */
  billed_cost_micro_usd: number;
  /** Requests with usage but no list price: their list cost is unknown, not zero. */
  unpriced_requests: number;
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
  alert_destinations: AlertDestinationsTable;
  alert_deliveries: AlertDeliveriesTable;
  route_overrides: RouteOverridesTable;
  guardrail_results: GuardrailResultsTable;
  idempotency_keys: IdempotencyKeysTable;
  usage_rollups_minute: UsageRollupsTable;
  usage_rollups_hour: UsageRollupsTable;
  usage_rollups_day: UsageRollupsTable;
}

export type Db = Kysely<Database>;

/** A Kysely instance over an existing pool. Destroying it ends the pool. */
export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
