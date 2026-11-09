import type { Clock } from '@ai-gateway/shared';
import { ProviderError } from '../providers/errors.js';
import type { ChatResult, StreamEvent, ToolCall } from '../providers/types.js';
import { ClientClosedError, type OpenStream } from './attempt.js';
import type { RequestTrace } from './trace.js';

const noop = () => undefined;

/**
 * One upstream call shared by identical requests that arrive while it runs, on this instance
 * (ADR 031). The first request (the leader) makes the call; the others (followers) wait for its
 * answer or its error. The call follows `signal`, which aborts only when nobody waits for it any
 * more: the leader's client leaving does not cancel it while followers wait.
 */
export class Flight<T> {
  readonly result: Promise<T>;
  readonly #controller = new AbortController();
  #resolve: (value: T) => void = noop;
  #reject: (error: unknown) => void = noop;
  #settled = false;
  #participants = 0;
  #followersWaiting = 0;
  #followers = 0;
  readonly #onSettled: () => void;

  constructor(onSettled: () => void) {
    this.#onSettled = onSettled;
    this.result = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // Nobody may be waiting when the leader fails.
    this.result.catch(noop);
  }

  /** Aborts when every participant has left before the answer came. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get settled(): boolean {
    return this.#settled;
  }

  /** Followers still waiting for the answer. */
  get followersWaiting(): number {
    return this.#followersWaiting;
  }

  /** Followers that joined in all. */
  get followers(): number {
    return this.#followers;
  }

  /**
   * Joins as a participant; the returned function leaves (once). The leader joins as well, and
   * leaves when its client goes away or its request ends.
   */
  enter(role: 'leader' | 'follower'): () => void {
    this.#participants++;
    if (role === 'follower') {
      this.#followers++;
      this.#followersWaiting++;
    }
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#participants--;
      if (role === 'follower') this.#followersWaiting--;
      if (this.#participants === 0 && !this.#settled) {
        this.#controller.abort(new ClientClosedError());
      }
    };
  }

  resolve(value: T): void {
    if (this.#settle()) this.#resolve(value);
  }

  reject(error: unknown): void {
    if (this.#settle()) this.#reject(error);
  }

  #settle(): boolean {
    if (this.#settled) return false;
    this.#settled = true;
    this.#onSettled();
    return true;
  }
}

/**
 * The flights running on this instance, by key: the request's cache key (ADR 013, ADR 029), which
 * holds the project, so two projects never share a call. A flight leaves the map once it has its
 * answer or error; later requests then use the cache, or start a flight of their own.
 */
export class Coalescer {
  readonly enabled: boolean;
  readonly #flights = new Map<string, Flight<unknown>>();

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** The running flight for `key` to follow, or a new one for this request to lead. */
  join<T>(key: string): { leader: boolean; flight: Flight<T> } {
    const running = this.#flights.get(key) as Flight<T> | undefined;
    // A flight everyone left is being cancelled: it would only bring its followers an abort.
    if (running && !running.settled && !running.signal.aborted) {
      return { leader: false, flight: running };
    }
    const flight: Flight<T> = new Flight<T>(() => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    this.#flights.set(key, flight as Flight<unknown>);
    return { leader: true, flight };
  }

  /** Flights running now. */
  get size(): number {
    return this.#flights.size;
  }
}

/**
 * Waits as a follower for the flight's answer, within the follower's own deadline
 * (REQUEST_DEADLINE_MS from its own arrival) and until its own client leaves. Leaving affects
 * nobody else, unless it was the last one waiting.
 */
export async function follow<T>(
  flight: Flight<T>,
  {
    clock,
    clientSignal,
    deadlineAt,
  }: { clock: Clock; clientSignal: AbortSignal; deadlineAt?: number | undefined },
): Promise<T> {
  const leave = flight.enter('follower');
  const timer = new AbortController();
  let onAbort: () => void = noop;
  try {
    const gone = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProviderError('canceled', 'client closed the request'));
      if (clientSignal.aborted) onAbort();
      else clientSignal.addEventListener('abort', onAbort, { once: true });
    });
    const waits: Promise<T>[] = [flight.result, gone];
    if (deadlineAt !== undefined) {
      waits.push(
        clock.sleep(Math.max(0, deadlineAt - clock.now()), timer.signal).then(() => {
          throw new ProviderError(
            'timeout',
            "the request's deadline passed while it waited for an identical request",
          );
        }),
      );
    }
    for (const w of waits) w.catch(noop);
    return await Promise.race(waits);
  } finally {
    timer.abort();
    clientSignal.removeEventListener('abort', onAbort);
    leave();
  }
}

/** A streamed leader's stream, shared with the followers waiting for its whole answer. */
export interface SharedStream extends OpenStream {
  /** Runs `fn` once the upstream stream is closed: at once, or after a background read ends. */
  whenClosed(fn: () => void): void;
}

export interface ShareOptions {
  /** Called with the whole answer when the finish event arrives (to cache or store it). */
  onAnswer?: ((result: ChatResult) => void) | undefined;
  /** Called once if the stream ends without an answer (failed, or closed early). */
  onFailure?: ((error: unknown) => void) | undefined;
  /**
   * Read the rest of the stream in the background whenever the leader's client leaves, not only
   * while followers wait: a request with an Idempotency-Key is finished and stored (ADR 032).
   */
  keepReading?: boolean | undefined;
}

/**
 * Shares a streamed leader's upstream stream with its flight (ADR 031) and its Idempotency-Key
 * (ADR 032). Events pass through to the leader's SSE body as they come and are assembled into one
 * answer, which resolves the flight (and goes to `onAnswer`, to be cached or stored) when the
 * finish event arrives. If the leader's client leaves while followers wait, or `keepReading` is
 * set, the rest of the stream is read in the background, so the answer is still complete and the
 * leader's record still holds the attempt and its usage; `whenClosed` callbacks then run after
 * that read ends.
 */
export function shareStream(
  stream: OpenStream,
  flight: Flight<ChatResult> | undefined,
  trace: RequestTrace,
  { onAnswer, onFailure, keepReading = false }: ShareOptions = {},
): SharedStream {
  const text: string[] = [];
  const calls: ToolCall[] = [];
  let closed = false;
  let draining = false;
  let answered = false;
  const waiting: (() => void)[] = [];

  const see = (r: IteratorResult<StreamEvent>, background: boolean) => {
    if (r.done) return r;
    const event = r.value;
    if (event.type === 'content') {
      text.push(event.text);
      if (background) trace.addCompletionText(event.text);
    } else if (event.type === 'tool_call') {
      calls[event.index] = { id: event.id, name: event.name, arguments: '' };
      if (background) trace.addCompletionText(event.name);
    } else if (event.type === 'tool_arguments') {
      const call = calls[event.index];
      if (call) call.arguments += event.text;
      if (background) trace.addCompletionText(event.text);
    } else {
      if (background) trace.setUsage(event.usage);
      const toolCalls = calls.filter((call) => call !== undefined);
      const result: ChatResult = {
        content: text.join(''),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        finishReason: event.finishReason,
        usage: event.usage,
      };
      answered = true;
      flight?.resolve(result);
      onAnswer?.(result);
    }
    return r;
  };

  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    const failure = error ?? new ProviderError('connection', 'stream ended without a finish event');
    flight?.reject(failure);
    if (!answered) onFailure?.(failure);
    stream.close(error);
    for (const fn of waiting.splice(0)) fn();
  };

  const drain = async () => {
    try {
      for (;;) {
        const r = see(await stream.next(), true);
        if (r.done) throw new ProviderError('connection', 'stream ended without a finish event');
        if (r.value.type === 'finish') return finish();
      }
    } catch (err) {
      finish(err);
    }
  };

  return {
    first: see(stream.first, false),
    next: async () => see(await stream.next(), false),
    close: (error?: unknown) => {
      if (closed || draining) return;
      const clientLeft = error instanceof ProviderError && error.kind === 'canceled';
      const followersWait = flight !== undefined && !flight.settled && flight.followersWaiting > 0;
      if (clientLeft && !answered && (keepReading || followersWait)) {
        draining = true;
        void drain();
        return;
      }
      finish(error);
    },
    whenClosed: (fn) => {
      if (closed) fn();
      else waiting.push(fn);
    },
  };
}
