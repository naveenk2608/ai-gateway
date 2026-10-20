import {
  estimateTokens,
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
  readonly attempts: AttemptRecord[] = [];
  #deployment: string | null = null;
  #firstTokenAt: number | undefined;
  #usage: Usage | null = null;
  #completionChars = 0;
  #errorCode: string | null = null;
  #finished = false;
  /** Set once the SSE body owns the response; the stream then finishes the trace itself. */
  streaming = false;

  constructor(start: TraceStart, clock: Clock) {
    this.#start = start;
    this.#clock = clock;
    this.startedAt = clock.now();
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
    this.#completionChars += text.length;
  }

  setUsage(usage: Usage | null): void {
    this.#usage = usage;
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
    const { usage, usageSource } = this.#usageFor();
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
    };
  }

  /**
   * `reported` when the provider sent counts; `estimated` when it did not but text was produced
   * (an interrupted stream, a provider that omits usage); otherwise `missing`.
   */
  #usageFor(): Pick<UsageEvent, 'usage' | 'usageSource'> {
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
    if (this.#completionChars > 0) {
      const promptText = this.#start.messages.map((m) => messageText(m.content)).join('\n');
      const promptTokens = estimateTokens(promptText);
      const completionTokens = Math.ceil(this.#completionChars / 4);
      return {
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        usageSource: 'estimated',
      };
    }
    return { usage: null, usageSource: 'missing' };
  }
}
