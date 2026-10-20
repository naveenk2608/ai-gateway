/**
 * The admin API, reached at /api (proxied to the gateway by Vite in development and by nginx in
 * the container), so the session cookie is same-origin.
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

export interface Overview {
  from: string;
  to: string;
  requests: number;
  succeeded: number;
  failed: number;
  rejected: number;
  canceled: number;
  cacheHits: number;
  totalTokens: number;
  costMicroUsd: number;
  month: { period: string; spentMicroUsd: number; budgetMicroUsd: number | null };
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
}

/** Calls the admin API; resolves with the JSON body (null for 204), rejects with ApiError. */
export async function api<T>(
  path: string,
  { method = 'GET', body, signal }: RequestOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`/api${path}`, {
      method,
      signal,
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
