import {
  estimatePromptTokens,
  estimateTextTokens,
  uuidv7,
  type AttemptRecord,
  type Clock,
  type UsageEvent,
} from '@ai-gateway/shared';
import { messageText, type ChatMessage, type Usage } from '../providers/types.js';

export interface TraceStart {
  requestId: string;
  projectId: string;
  apiKeyId: string | null;
  model: string;
  stream: boolean;
  messages: readonly ChatMessage[];
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The lifecycle of one logical request: its upstream attempts, timing and usage. It becomes one
 * `request.completed` usage event when the request ends, exactly once.
 */
export class RequestTrace {
  readonly #clock: Clock;
  readonly #start: TraceStart;
  readonly startedAt: number;
  /** Tokenizer approximation of the prompt, used by limits and budgets before the call. */
  readonly estimatedPromptTokens: number;
  readonly attempts: AttemptRecord[] = [];
  #deployment: string | null = null;
  #firstTokenAt: number | undefined;
  #usage: Usage | null = null;
  /** Estimated tokens of the completion text seen so far, summed per chunk. */
  #completionTokens = 0;
  #completionText = false;
  #errorCode: string | null = null;
  #budget: UsageEvent['budget'];
  #finished = false;
  /** Set once the SSE body owns the response; the stream then finishes the trace itself. */
  streaming = false;

  constructor(start: TraceStart, clock: Clock) {
    this.#start = start;
    this.#clock = clock;
    this.startedAt = clock.now();
    this.estimatedPromptTokens = estimatePromptTokens(
      start.messages.map((m) => ({ text: messageText(m.content), name: m.name })),
    );
  }

  get requestId(): string {
    return this.#start.requestId;
  }

  nextAttemptNumber(): number {
    return this.attempts.length + 1;
  }

  recordAttempt(record: Omit<AttemptRecord, 'routingPolicy' | 'routingReason'>): void {
    this.attempts.push({ ...record, routingPolicy: null, routingReason: null });
    this.#deployment = record.deployment;
  }

  markFirstToken(): void {
    this.#firstTokenAt ??= this.#clock.now();
  }

  addCompletionText(text: string): void {
    if (text === '') return;
    this.#completionText = true;
    this.#completionTokens += estimateTextTokens(text);
  }

  setUsage(usage: Usage | null): void {
    this.#usage = usage;
  }

  /** Records the budget reservation made at admission, for the worker's audit. */
  setBudget(budget: NonNullable<UsageEvent['budget']>): void {
    this.#budget = budget;
  }

  setError(code: string): void {
    this.#errorCode ??= code;
  }

  /** Builds the event; returns null if the trace was already finished. */
  finish(httpStatus: number): UsageEvent | null {
    if (this.#finished) return null;
    this.#finished = true;
    const now = this.#clock.now();
    const errorCode = this.#errorCode ?? (httpStatus >= 400 ? 'http_error' : null);
    const status =
      errorCode === 'client_closed_request'
        ? 'canceled'
        : errorCode === null
          ? 'success'
          : this.attempts.length === 0
            ? 'rejected'
            : 'error';
    const { usage, usageSource } = this.usage();
    return {
      v: 1,
      type: 'request.completed',
      eventId: uuidv7(now),
      occurredAt: iso(now),
      request: {
        id: this.#start.requestId,
        projectId: this.#start.projectId,
        apiKeyId: this.#start.apiKeyId,
        model: this.#start.model,
        deployment: this.#deployment,
        stream: this.#start.stream,
        status,
        httpStatus,
        errorCode,
        startedAt: iso(this.startedAt),
        completedAt: iso(now),
        latencyMs: Math.max(0, now - this.startedAt),
        ttftMs:
          this.#start.stream && this.#firstTokenAt !== undefined
            ? this.#firstTokenAt - this.startedAt
            : null,
      },
      attempts: this.attempts,
      usage,
      usageSource,
      estimatedPromptTokens: this.estimatedPromptTokens,
      ...(this.#budget ? { budget: this.#budget } : {}),
    };
  }

  /**
   * `reported` when the provider sent counts; `estimated` when it did not but text was produced
   * (an interrupted stream, a provider that omits usage); otherwise `missing`.
   */
  usage(): Pick<UsageEvent, 'usage' | 'usageSource'> {
    if (this.#usage) {
      return {
        usage: {
          promptTokens: this.#usage.promptTokens,
          completionTokens: this.#usage.completionTokens,
          totalTokens: this.#usage.totalTokens,
        },
        usageSource: 'reported',
      };
    }
    if (this.#completionText) {
      const promptTokens = this.estimatedPromptTokens;
      const completionTokens = this.#completionTokens;
      return {
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        usageSource: 'estimated',
      };
    }
    return { usage: null, usageSource: 'missing' };
  }
}
