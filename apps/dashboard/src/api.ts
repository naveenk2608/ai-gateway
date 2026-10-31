/**
 * The admin API, on the origin that serves the dashboard: the gateway itself (/dashboard/), or
 * Vite's proxy to it in development. So the session cookie is same-origin.
 */

export type Role = 'owner' | 'admin' | 'viewer';

export interface Me {
  user: { id: string; email: string };
  projects: { id: string; name: string; role: Role }[];
}

export interface Limits {
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  concurrentRequests: number | null;
}

export interface ApiKey {
  id: string;
  name: string;
  maskedKey: string;
  status: 'active' | 'expiring' | 'expired' | 'revoked';
  limits: Limits;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  rotatedTo: string | null;
}

export type RequestStatus = 'success' | 'error' | 'canceled' | 'rejected';

export interface RequestSummary {
  id: string;
  apiKeyId: string | null;
  model: string;
  deployment: string | null;
  stream: boolean;
  status: RequestStatus;
  httpStatus: number;
  errorCode: string | null;
  attemptCount: number;
  cacheHit: boolean;
  startedAt: string;
  latencyMs: number;
  totalTokens: number | null;
  costMicroUsd: number | null;
}

export interface Attempt {
  id: string;
  attemptNumber: number;
  deployment: string;
  provider: string;
  outcome: string;
  upstreamStatus: number | null;
  routingPolicy: string | null;
  routingReason: string | null;
  latencyMs: number;
  ttftMs: number | null;
}

export interface RequestDetail extends Omit<
  RequestSummary,
  'attemptCount' | 'totalTokens' | 'costMicroUsd'
> {
  completedAt: string;
  ttftMs: number | null;
  usage: {
    source: 'reported' | 'estimated' | 'missing';
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    costMicroUsd: number | null;
  } | null;
  attempts: Attempt[];
}

export interface Budget {
  monthlyLimitMicroUsd: number | null;
  maxRequestCostMicroUsd: number | null;
}

export interface Project {
  id: string;
  name: string;
  allowedModels: string[] | null;
  limits: Limits;
  budget: Budget;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  userId: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface ModelCatalog {
  deployments: {
    id: string;
    provider: string;
    providerModel: string;
    enabled: boolean;
    timeoutMs: number;
    streamIdleTimeoutMs: number;
    maxOutputTokens: number;
  }[];
  models: {
    name: string;
    policy: string;
    targets: { deployment: string; weight: number }[];
    available: boolean;
  }[];
}

// --- Analytics API (M6) ---

export interface Window {
  range: string;
  from: string;
  to: string;
  granularity: 'minute' | 'hour' | 'day';
  stepSeconds: number;
}

/** Milliseconds; percentiles are approximate (histogram buckets). */
export interface LatencySummary {
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface Metrics {
  requests: number;
  succeeded: number;
  failed: number;
  rejected: number;
  canceled: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  attempts: number;
  retries: number;
  fallbacks: number;
  errorRate: number | null;
  fallbackRate: number | null;
  latencyMs: LatencySummary;
  ttftMs: LatencySummary;
  outputTokensPerSecond: number | null;
}

export interface OverviewResponse {
  window: Window;
  totals: Metrics;
  series: {
    start: string;
    requests: number;
    succeeded: number;
    failed: number;
    rejected: number;
    canceled: number;
  }[];
  month: { period: string; spentMicroUsd: number };
}

export interface RequestPage {
  window: Window;
  data: (RequestSummary & { projectId: string; provider: string | null })[];
  nextCursor: string | null;
}

export interface ModelsResponse {
  window: Window;
  data: { model: string; deployment: string | null; provider: string | null; metrics: Metrics }[];
}

export interface Spend {
  requests: number;
  totalTokens: number;
  costMicroUsd: number;
}

export interface BudgetStatus {
  projectId: string;
  projectName: string;
  period: string;
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
  usedShare: number | null;
  alert: 'ok' | 'warning' | 'exceeded' | null;
}

export interface CostResponse {
  window: Window;
  totals: Spend & { promptTokens: number; completionTokens: number };
  byProvider: (Spend & { provider: string | null })[];
  byModel: (Spend & { model: string })[];
  byProject: (Spend & { projectId: string; projectName: string })[];
  byApiKey: (Spend & { apiKeyId: string | null; name: string | null })[];
  series: { start: string; costMicroUsd: number; totalTokens: number }[];
  budgets: BudgetStatus[];
  projection: { monthlyCostMicroUsd: number | null; reason: string | null; daysOfData: number };
}

export interface BreakerInstance {
  instanceId: string;
  state: 'closed' | 'open' | 'half_open';
  reason: string | null;
  at: string | null;
}

export interface ReliabilityResponse {
  window: Window;
  totals: Metrics;
  errorsByCode: { status: RequestStatus; errorCode: string | null; requests: number }[];
  byDeployment: {
    deployment: string | null;
    provider: string | null;
    requests: number;
    failed: number;
    attempts: number;
    retries: number;
    fallbacks: number;
  }[];
  series: { start: string; requests: number; failed: number; retries: number; fallbacks: number }[];
  breakers: { deployment: string; instances: BreakerInstance[] }[] | null;
  healthEvents: {
    deployment: string;
    instanceId: string;
    fromState: string | null;
    toState: string;
    reason: string | null;
    occurredAt: string;
  }[];
}

export interface SecurityResponse {
  window: Window;
  rejected: number;
  byCategory: { category: string; requests: number }[];
  byCode: { errorCode: string | null; category: string; requests: number }[];
  byApiKey: { apiKeyId: string | null; name: string | null; requests: number }[];
  series: { start: string; rejected: number }[];
  invalidApiKeys: { count: null; reason: string };
}

export interface InfraResponse {
  window: Window;
  measuredAt: string;
  pipeline: {
    streamLength: number;
    unreadEvents: number | null;
    pendingEvents: number;
    oldestPendingAgeMs: number | null;
    consumers: number;
    deadLetterLength: number;
  } | null;
  failedEvents: { total: number; inWindow: number };
  dependencies: Record<string, { status: 'ok' | 'fail'; latencyMs: number }>;
  /** The gateway process that answered; CPU and event-loop delay are null on its first reading. */
  instance: {
    uptimeSeconds: number;
    residentMemoryBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    cpuShare: number | null;
    eventLoopDelayP99Ms: number | null;
    usageEvents: { buffered: number; published: number; dropped: number };
  };
}

export const RANGES = ['1h', '24h', '7d', '30d'] as const;
export type Range = (typeof RANGES)[number];

export interface AnalyticsFilters {
  range: Range;
  apiKeyId?: string;
  provider?: string;
  model?: string;
  status?: RequestStatus;
}

/** `/admin/analytics/<section>?projectId=...&range=...` plus the filters that are set. */
export function analyticsPath(
  section: string,
  projectId: string,
  filters: AnalyticsFilters,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams({ projectId });
  for (const [name, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== undefined && value !== '') params.set(name, String(value));
  }
  return `/admin/analytics/${section}?${params.toString()}`;
}

/** An error from the admin API, with its OpenAI-style code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Lets the call finish after the page is gone (revoking a key when the tab closes). */
  keepalive?: boolean;
}

/** Calls the admin API; resolves with the JSON body (null for 204), rejects with ApiError. */
export async function api<T>(
  path: string,
  { method = 'GET', body, signal, keepalive }: RequestOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(path, {
      method,
      signal,
      keepalive,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, 'network_error', 'The gateway could not be reached.');
  }
  if (res.status === 204) return null as T;
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return json as T;
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  throw new ApiError(
    res.status,
    typeof error?.code === 'string' ? error.code : 'http_error',
    typeof error?.message === 'string' ? error.message : `Request failed (HTTP ${res.status}).`,
  );
}

export const isUnauthenticated = (err: unknown) => err instanceof ApiError && err.status === 401;

/** Roles that may change keys and settings. */
export const canManage = (role: Role) => role === 'owner' || role === 'admin';
