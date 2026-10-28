import { sseData } from './sse.js';

/**
 * The gateway's OpenAI-compatible API, called like any client would. The key is sent only to
 * `gatewayUrl`, as a bearer token; no cookies, no referrer.
 */

export interface Connection {
  gatewayUrl: string;
  apiKey: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ProblemKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'budget'
  | 'bad_request'
  | 'unavailable'
  | 'unreachable'
  | 'server';

/** A failed call, with what the gateway said about it. */
export class GatewayProblem extends Error {
  readonly kind: ProblemKind;
  /** The HTTP status; null when no response arrived or the error came inside a stream. */
  readonly status: number | null;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | null;

  constructor(
    kind: ProblemKind,
    message: string,
    details: {
      status?: number | null;
      code?: string | null;
      retryAfterSeconds?: number | null;
      requestId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'GatewayProblem';
    this.kind = kind;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.requestId = details.requestId ?? null;
  }
}

export type Fetch = typeof fetch;

/** Retry-After as seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

const RATE_LIMIT_CODES = new Set([
  'rpm_limit_exceeded',
  'tpm_limit_exceeded',
  'concurrency_limit_exceeded',
]);

function kindOf(status: number, code: string | null, fromGateway: boolean): ProblemKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return code === 'budget_exceeded' ? 'budget' : 'rate_limit';
  if (status === 400 || status === 413 || status === 422) return 'bad_request';
  // A 502/503/504 without the gateway's error body came from the host in front of it: the
  // gateway is starting (or restarting) and not answering yet.
  if (status === 502 || status === 503 || status === 504) {
    return fromGateway ? 'unavailable' : 'unreachable';
  }
  return 'server';
}

/** The problem an error response describes. */
export async function problemFrom(res: Response): Promise<GatewayProblem> {
  const body: unknown = await res.json().catch(() => null);
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : null;
  const message =
    typeof error?.message === 'string' ? error.message : `The gateway answered HTTP ${res.status}.`;
  return new GatewayProblem(kindOf(res.status, code, error !== undefined), message, {
    status: res.status,
    code,
    retryAfterSeconds: retryAfterSeconds(res.headers.get('retry-after')),
    requestId: res.headers.get('x-request-id'),
  });
}

/** A failure inside a stream that had already started (the status was 200). */
function streamProblem(error: { code?: unknown; message?: unknown }): GatewayProblem {
  const code = typeof error.code === 'string' ? error.code : null;
  const message = typeof error.message === 'string' ? error.message : 'The stream failed.';
  const kind: ProblemKind =
    code === 'budget_exceeded'
      ? 'budget'
      : code !== null && RATE_LIMIT_CODES.has(code)
        ? 'rate_limit'
        : 'server';
  return new GatewayProblem(kind, message, { code });
}

async function call(
  conn: Connection,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
  fetchFn: Fetch,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(`${conn.gatewayUrl}${path}`, {
      method: init.method,
      signal: init.signal,
      headers: {
        authorization: `Bearer ${conn.apiKey}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    // The browser hides why: offline, DNS, a sleeping host, or a CORS refusal all look alike.
    throw new GatewayProblem('unreachable', 'The gateway could not be reached.');
  }
  if (!res.ok) throw await problemFrom(res);
  return res;
}

/** The models this key may use (`GET /v1/models`). */
export async function listModels(
  conn: Connection,
  signal?: AbortSignal,
  fetchFn: Fetch = fetch,
): Promise<string[]> {
  const res = await call(conn, '/v1/models', { method: 'GET', signal }, fetchFn);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [m.id] : []));
}

/** What the response headers say about how the reply was served. */
export interface Served {
  requestId: string | null;
  /** The deployment that answered; null for a cache hit. */
  deployment: string | null;
  /** Deployments the gateway moved on from first (they failed or their circuit was open). */
  fallbackFrom: string[];
  cacheHit: boolean;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatOutcome {
  finishReason: string | null;
  usage: Usage | null;
}

interface Chunk {
  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | null;
  error?: { code?: unknown; message?: unknown };
}

function usageFrom(usage: Chunk['usage']): Usage | null {
  if (!usage) return null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    promptTokens: n(usage.prompt_tokens),
    completionTokens: n(usage.completion_tokens),
    totalTokens: n(usage.total_tokens),
  };
}

/**
 * Sends the conversation and streams the reply: `onServed` once the headers arrive, `onText` for
 * each piece of text. Resolves when the stream ends; rejects with a GatewayProblem, or with the
 * abort error when `signal` stops it.
 */
export async function streamChat(
  conn: Connection,
  request: { model: string; messages: ChatMessage[] },
  handlers: { onServed: (served: Served) => void; onText: (text: string) => void },
  signal: AbortSignal,
  fetchFn: Fetch = fetch,
): Promise<ChatOutcome> {
  const res = await call(
    conn,
    '/v1/chat/completions',
    {
      method: 'POST',
      signal,
      body: { ...request, stream: true, stream_options: { include_usage: true } },
    },
    fetchFn,
  );
  const fallback = res.headers.get('x-gateway-fallback-from');
  handlers.onServed({
    requestId: res.headers.get('x-request-id'),
    deployment: res.headers.get('x-gateway-deployment'),
    fallbackFrom: fallback ? fallback.split(',').map((d) => d.trim()) : [],
    cacheHit: res.headers.get('x-gateway-cache') === 'hit',
  });
  if (!res.body) throw new GatewayProblem('server', 'The gateway sent no body.');

  const outcome: ChatOutcome = { finishReason: null, usage: null };
  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') return outcome;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      throw new GatewayProblem('server', 'The gateway sent an event that is not JSON.');
    }
    if (chunk.error) throw streamProblem(chunk.error);
    const choice = chunk.choices?.[0];
    const text = choice?.delta?.content;
    if (typeof text === 'string' && text !== '') handlers.onText(text);
    if (typeof choice?.finish_reason === 'string') outcome.finishReason = choice.finish_reason;
    if (chunk.usage) outcome.usage = usageFrom(chunk.usage);
  }
  // A stream that ends without [DONE] was cut off.
  throw new GatewayProblem('server', 'The reply stream ended early.');
}
