import { abortReason, childSpan, formatTraceparent, uuidv7, type Clock } from '@ai-gateway/shared';
import type { FastifyBaseLogger } from 'fastify';
import { ProviderError } from '../providers/errors.js';
import type { Deployment } from '../providers/registry.js';
import type { ChatRequest, ChatResult, StreamEvent } from '../providers/types.js';
import type { RequestTrace } from './trace.js';

/** Abort reason when the client disconnects before the response is complete. */
export class ClientClosedError extends Error {
  constructor() {
    super('client closed the request');
    this.name = 'ClientClosedError';
  }
}

export type TimeoutPhase = 'response' | 'first_event' | 'idle';

/** Abort reason when an attempt runs past one of its deadlines. */
export class AttemptTimeoutError extends Error {
  readonly phase: TimeoutPhase;
  readonly timeoutMs: number;

  constructor(phase: TimeoutPhase, timeoutMs: number) {
    super(`no ${phase === 'response' ? 'response' : 'stream event'} within ${timeoutMs} ms`);
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
  /** Told how the attempt ended, once: feeds circuit breakers and latency tracking. */
  onEnd?: (outcome: AttemptOutcome) => void;
}

export interface AttemptOutcome {
  /** The failure, or undefined on success. */
  error: unknown;
  latencyMs: number;
  ttftMs: number | null;
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
  #ended = false;
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
    this.#ctx.onEnd?.({ error, latencyMs: Math.max(0, now - this.#startedAt), ttftMs });
    this.#ctx.trace?.recordAttempt({
      id: this.id,
      attemptNumber: this.#number,
      deployment: this.#ctx.deployment.id,
      provider: this.#ctx.deployment.provider.kind,
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
      provider: this.#ctx.deployment.provider.kind,
      routing: this.#ctx.routing?.reason,
      stream: this.#stream,
      durationMs: now - this.#startedAt,
      ttftMs: this.#firstEventAt === undefined ? undefined : this.#firstEventAt - this.#startedAt,
      outcome: outcome === 'success' ? 'ok' : outcome,
      upstreamStatus: error instanceof ProviderError ? error.upstreamStatus : undefined,
      upstreamCode: error instanceof ProviderError ? error.upstreamCode : undefined,
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
    const result = await attempt.within(
      ctx.deployment.provider.chat(withTrace(req, attempt), attempt.signal),
      ctx.deployment.timeoutMs,
      'response',
    );
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
    const first = await attempt.within(iterator.next(), ctx.deployment.timeoutMs, 'first_event');
    attempt.markFirstEvent();
    return {
      first,
      next: () => attempt.within(iterator.next(), ctx.deployment.streamIdleTimeoutMs, 'idle'),
      close,
    };
  } catch (err) {
    close(err);
    throw err;
  }
}
