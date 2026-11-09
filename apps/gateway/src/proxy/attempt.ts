import { openSpan, type SpanHandle } from '@ai-gateway/shared/node';
import { abortReason, childSpan, formatTraceparent, uuidv7, type Clock } from '@ai-gateway/shared';
import type { FastifyBaseLogger } from 'fastify';
import { ProviderError } from '../providers/errors.js';
import type { Deployment } from '../providers/registry.js';
import type {
  ChatRequest,
  ChatResult,
  EmbeddingRequest,
  EmbeddingResult,
  RateLimitHeaders,
  StreamEvent,
  Usage,
} from '../providers/types.js';
import type { RequestTrace } from './trace.js';

/** Abort reason when the client disconnects before the response is complete. */
export class ClientClosedError extends Error {
  constructor() {
    super('client closed the request');
    this.name = 'ClientClosedError';
  }
}

/** `deadline`: the request's own deadline (REQUEST_DEADLINE_MS) came before the deployment's. */
export type TimeoutPhase = 'response' | 'first_event' | 'idle' | 'deadline';

/** Abort reason when an attempt runs past one of its deadlines. */
export class AttemptTimeoutError extends Error {
  readonly phase: TimeoutPhase;
  readonly timeoutMs: number;

  constructor(phase: TimeoutPhase, timeoutMs: number) {
    super(
      phase === 'deadline'
        ? `the request's deadline passed after ${timeoutMs} ms of this attempt`
        : `no ${phase === 'response' ? 'response' : 'stream event'} within ${timeoutMs} ms`,
    );
    this.name = 'AttemptTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

class StreamClosedError extends Error {
  constructor() {
    super('stream closed by the gateway');
    this.name = 'StreamClosedError';
  }
}

export interface AttemptContext {
  deployment: Deployment;
  clock: Clock;
  /** Aborts when the client goes away. */
  clientSignal: AbortSignal;
  log: FastifyBaseLogger;
  /** Receives one record per attempt for the usage event. */
  trace?: RequestTrace;
  /** The routing policy and why this deployment was tried (M5), stored on the attempt. */
  routing?: { policy: string; reason: string };
  /**
   * Deployments the request moved on from before this one, in order: each failed, or was skipped
   * while its circuit was open. Empty when this is the first choice (retries on it included).
   */
  passedOver?: readonly string[];
  /** Told how the attempt ended, once: feeds circuit breakers and latency tracking. */
  onEnd?: (outcome: AttemptOutcome) => void;
  /**
   * When the whole request must have its response started (clock time, REQUEST_DEADLINE_MS). An
   * attempt that would run past it is cut at it; nothing limits a stream once its first event came.
   */
  deadlineAt?: number;
}

/** The time an attempt may wait for its response (or first event): its timeout, or less. */
function untilFirst(ctx: AttemptContext, phase: TimeoutPhase): { ms: number; phase: TimeoutPhase } {
  const timeoutMs = ctx.deployment.timeoutMs;
  if (ctx.deadlineAt === undefined) return { ms: timeoutMs, phase };
  const left = ctx.deadlineAt - ctx.clock.now();
  return left < timeoutMs ? { ms: Math.max(0, left), phase: 'deadline' } : { ms: timeoutMs, phase };
}

export interface AttemptOutcome {
  /** The failure, or undefined on success. */
  error: unknown;
  latencyMs: number;
  ttftMs: number | null;
  /** Tokens the provider reported; null when it reported none or the attempt failed first. */
  usage: Usage | null;
  /** The provider's own rate-limit counts, from its response headers. */
  rateLimit?: RateLimitHeaders | undefined;
  /** Which of the attempt's limits cut it, when it timed out (`deadline`: the request's own). */
  timeoutPhase?: TimeoutPhase | undefined;
  /** A streamed try: its latency sample is the time to first token (ADR 030). */
  stream?: boolean | undefined;
}

/** The phase of the gateway's own timeout behind a failure, if one cut the attempt. */
function timeoutPhaseOf(error: unknown): TimeoutPhase | undefined {
  if (!(error instanceof ProviderError) || error.kind !== 'timeout') return undefined;
  return error.cause instanceof AttemptTimeoutError ? error.cause.phase : undefined;
}

const noop = () => undefined;

/**
 * One upstream try (ADR 004). It owns an abort controller that fires when the client disconnects
 * or a deadline passes, so the provider call stops either way; it logs one line with its attemptId.
 */
class Attempt {
  readonly id: string;
  readonly log: FastifyBaseLogger;
  /** The `traceparent` for the upstream call: a child span of the request's (ADR 017). */
  readonly traceparent: string | undefined;
  readonly #ctx: AttemptContext;
  readonly #stream: boolean;
  readonly #controller = new AbortController();
  readonly #startedAt: number;
  readonly #number: number;
  #firstEventAt: number | undefined;
  #usage: Usage | null = null;
  #rateLimit: RateLimitHeaders | undefined;
  #ended = false;
  #span: SpanHandle | undefined;
  readonly #onClientAbort = () => this.#controller.abort(new ClientClosedError());

  constructor(ctx: AttemptContext, stream: boolean) {
    this.#ctx = ctx;
    this.#stream = stream;
    this.#startedAt = ctx.clock.now();
    this.id = uuidv7(this.#startedAt);
    this.#number = ctx.trace?.nextAttemptNumber() ?? 1;
    const parent = ctx.trace?.traceContext;
    const span = parent ? childSpan(parent) : undefined;
    this.traceparent = span ? formatTraceparent(span) : undefined;
    // With tracing on, the attempt is exported as a span with the same ID (ADR 037).
    this.#span = span
      ? openSpan('provider.attempt', span, {
          kind: 'client',
          attributes: {
            'gateway.deployment': ctx.deployment.id,
            'gateway.provider': ctx.deployment.providerName,
            'gateway.provider_model': ctx.deployment.providerModel,
            'gateway.attempt': this.#number,
            'gateway.stream': stream,
          },
        })
      : undefined;
    // The request's logger already has traceId and its own spanId.
    this.log = ctx.log.child({
      attemptId: this.id,
      deployment: ctx.deployment.id,
      ...(span ? { attemptSpanId: span.spanId } : {}),
    });
    if (ctx.clientSignal.aborted) this.#onClientAbort();
    else ctx.clientSignal.addEventListener('abort', this.#onClientAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  abort(reason: unknown): void {
    this.#controller.abort(reason);
  }

  markFirstEvent(): void {
    this.#firstEventAt ??= this.#ctx.clock.now();
  }

  /** Keeps what the provider reported about usage and its rate limits, for the outcome. */
  report(usage: Usage | null, rateLimit: RateLimitHeaders | undefined): void {
    this.#usage = usage;
    this.#rateLimit = rateLimit;
  }

  /** Reports a stream's finish event when it passes through. */
  seen(result: IteratorResult<StreamEvent>): IteratorResult<StreamEvent> {
    if (!result.done && result.value.type === 'finish') {
      this.report(result.value.usage, result.value.rateLimit);
    }
    return result;
  }

  /**
   * Waits for `work`, aborting the attempt if it takes longer than `ms`. Settles as soon as the
   * attempt aborts, even if the provider is slow to notice, and turns abort reasons into
   * ProviderErrors ('timeout' or 'canceled').
   */
  async within<T>(work: Promise<T>, ms: number, phase: TimeoutPhase): Promise<T> {
    const timer = new AbortController();
    let onAbort: () => void = noop;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortReason(this.signal));
    });
    aborted.catch(noop);
    work.catch(noop);
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener('abort', onAbort, { once: true });
    this.#ctx.clock
      .sleep(ms, timer.signal)
      .then(() => this.#controller.abort(new AttemptTimeoutError(phase, ms)), noop);
    try {
      return await Promise.race([work, aborted]);
    } catch (err) {
      throw this.#normalize(err);
    } finally {
      timer.abort();
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Logs the outcome once and detaches from the client signal. */
  end(error?: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#ctx.clientSignal.removeEventListener('abort', this.#onClientAbort);
    const now = this.#ctx.clock.now();
    const outcome =
      error === undefined ? 'success' : error instanceof ProviderError ? error.kind : 'error';
    const ttftMs = this.#firstEventAt === undefined ? null : this.#firstEventAt - this.#startedAt;
    const upstreamStatus = error instanceof ProviderError ? error.upstreamStatus : undefined;
    this.#span?.set({
      'gateway.outcome': outcome,
      ...(upstreamStatus === undefined ? {} : { 'http.response.status_code': upstreamStatus }),
    });
    this.#span?.end(outcome === 'success' ? undefined : outcome);
    this.#ctx.onEnd?.({
      error,
      latencyMs: Math.max(0, now - this.#startedAt),
      ttftMs,
      usage: this.#usage,
      rateLimit: this.#rateLimit,
      timeoutPhase: timeoutPhaseOf(error),
      stream: this.#stream,
    });
    this.#ctx.trace?.recordAttempt({
      id: this.id,
      attemptNumber: this.#number,
      deployment: this.#ctx.deployment.id,
      provider: this.#ctx.deployment.providerName,
      adapter: this.#ctx.deployment.adapter,
      billing: this.#ctx.deployment.billing,
      providerModel: this.#ctx.deployment.providerModel,
      outcome,
      upstreamStatus: error instanceof ProviderError ? (error.upstreamStatus ?? null) : null,
      startedAt: new Date(this.#startedAt).toISOString(),
      completedAt: new Date(now).toISOString(),
      latencyMs: Math.max(0, now - this.#startedAt),
      ttftMs,
      routingPolicy: this.#ctx.routing?.policy ?? null,
      routingReason: this.#ctx.routing?.reason ?? null,
    });
    const fields = {
      provider: this.#ctx.deployment.providerName,
      routing: this.#ctx.routing?.reason,
      stream: this.#stream,
      durationMs: now - this.#startedAt,
      ttftMs: this.#firstEventAt === undefined ? undefined : this.#firstEventAt - this.#startedAt,
      outcome: outcome === 'success' ? 'ok' : outcome,
      upstreamStatus: error instanceof ProviderError ? error.upstreamStatus : undefined,
      upstreamCode: error instanceof ProviderError ? error.upstreamCode : undefined,
      // Already cut and cleaned of keys and request text by the adapter (loggableMessage).
      upstreamMessage: error instanceof ProviderError ? error.upstreamMessage : undefined,
      // The gateway's own fixed text, e.g. where an unreadable response broke or a timeout's phase.
      reason: error instanceof ProviderError ? error.message : undefined,
    };
    if (error === undefined || (error instanceof ProviderError && error.kind === 'canceled')) {
      this.log.info(fields, 'provider attempt finished');
    } else if (error instanceof ProviderError) {
      this.log.warn(fields, 'provider attempt failed');
    } else {
      this.log.error({ ...fields, err: error }, 'provider attempt failed unexpectedly');
    }
  }

  #normalize(err: unknown): unknown {
    if (this.signal.aborted) {
      const reason: unknown = this.signal.reason;
      if (reason instanceof AttemptTimeoutError) {
        return new ProviderError('timeout', reason.message, { cause: reason });
      }
      if (reason instanceof ClientClosedError) return new ProviderError('canceled', reason.message);
    }
    // A ProviderError from the adapter, or an unexpected bug left for the 500 handler.
    return err;
  }
}

function withTrace(req: ChatRequest, attempt: Attempt): ChatRequest {
  return attempt.traceparent === undefined ? req : { ...req, traceparent: attempt.traceparent };
}

/** Runs one non-streaming attempt within the deployment's timeout. */
export async function runChat(ctx: AttemptContext, req: ChatRequest): Promise<ChatResult> {
  const attempt = new Attempt(ctx, false);
  try {
    const limit = untilFirst(ctx, 'response');
    const result = await attempt.within(
      ctx.deployment.provider.chat(withTrace(req, attempt), attempt.signal),
      limit.ms,
      limit.phase,
    );
    attempt.report(result.usage, result.rateLimit);
    attempt.end();
    return result;
  } catch (err) {
    attempt.end(err);
    throw err;
  }
}

/**
 * Runs one embeddings attempt within the deployment's timeout and the request's deadline. An
 * answer with the wrong number of vectors, or vectors of another size than the deployment's (or
 * the requested) dimensions, is an invalid response: vectors of another size must never reach a
 * client's index (ADR 029).
 */
export async function runEmbed(
  ctx: AttemptContext,
  req: EmbeddingRequest,
): Promise<EmbeddingResult> {
  const attempt = new Attempt(ctx, false);
  try {
    const limit = untilFirst(ctx, 'response');
    const traced =
      attempt.traceparent === undefined ? req : { ...req, traceparent: attempt.traceparent };
    const result = await attempt.within(
      ctx.deployment.provider.embed(traced, attempt.signal),
      limit.ms,
      limit.phase,
    );
    const size = req.dimensions ?? ctx.deployment.embedding?.dimensions;
    if (result.vectors.length !== req.input.length) {
      throw new ProviderError(
        'invalid_response',
        `upstream sent ${result.vectors.length} vectors for ${req.input.length} inputs`,
      );
    }
    if (size !== undefined && result.vectors.some((v) => v.length !== size)) {
      throw new ProviderError(
        'invalid_response',
        `upstream sent vectors that are not ${size} long`,
      );
    }
    attempt.report(result.usage, result.rateLimit);
    attempt.end();
    return result;
  } catch (err) {
    attempt.end(err);
    throw err;
  }
}

export interface OpenStream {
  /** The first event, received before any byte is sent to the client. */
  readonly first: IteratorResult<StreamEvent>;
  /** The next event, within the deployment's idle timeout. */
  next(): Promise<IteratorResult<StreamEvent>>;
  /** Ends the attempt, stopping the provider if it is still running. Pass the failure, if any. */
  close(error?: unknown): void;
}

/**
 * Starts a streaming attempt and waits for its first event within the deployment's timeout, so
 * failures before the first token still become a normal HTTP error (and, in M5, a retry).
 */
export async function openStream(ctx: AttemptContext, req: ChatRequest): Promise<OpenStream> {
  const attempt = new Attempt(ctx, true);
  const iterator = ctx.deployment.provider
    .chatStream(withTrace(req, attempt), attempt.signal)
    [Symbol.asyncIterator]();
  const close = (error?: unknown) => {
    attempt.end(error);
    attempt.abort(new StreamClosedError());
    void iterator.return?.().catch(noop);
  };
  try {
    const limit = untilFirst(ctx, 'first_event');
    const first = attempt.seen(await attempt.within(iterator.next(), limit.ms, limit.phase));
    attempt.markFirstEvent();
    return {
      first,
      next: async () =>
        attempt.seen(
          await attempt.within(iterator.next(), ctx.deployment.streamIdleTimeoutMs, 'idle'),
        ),
      close,
    };
  } catch (err) {
    close(err);
    throw err;
  }
}
