import type { Clock } from '@ai-gateway/shared';
import { ProviderError } from './errors.js';
import {
  messageText,
  type ChatRequest,
  type ChatResult,
  type FinishReason,
  type Provider,
  type StreamEvent,
  type Usage,
} from './types.js';

export interface MockSettings {
  /** Non-streaming: delay before the whole response. */
  latencyMs: number;
  /** Streaming: delay before the first token. */
  ttftMs: number;
  /** Streaming: token rate after the first token; undefined sends them without delay. */
  tokensPerSecond?: number | undefined;
  /** Tokens to generate when `max_tokens` does not cut it shorter. */
  completionTokens: number;
  /** Probability (0..1) that a request fails with a 500, drawn from a seeded RNG. */
  errorRate: number;
  seed: number;
  /** Fail every request with this status. */
  failWith?: 429 | 500 | undefined;
  /** Retry-After sent with forced 429s. */
  retryAfterMs: number;
  /** Streaming: drop the connection after this many tokens. Non-streaming: fail mid-response. */
  dropAfterTokens?: number | undefined;
}

export interface MockStats {
  /** Requests received. */
  requests: number;
  /** Requests still running. */
  active: number;
  completed: number;
  /** Requests that failed on purpose (forced status, error rate, drop). */
  failed: number;
  /** Requests stopped by their abort signal (client disconnect or timeout). */
  canceled: number;
  tokensEmitted: number;
}

const WORDS = ['This', 'is', 'a', 'deterministic', 'response', 'from', 'the', 'mock', 'provider.'];

/** mulberry32: a small, fast seeded PRNG, so error-rate failures repeat exactly for a seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Rough prompt size: about four characters per token. */
function estimatePromptTokens(req: ChatRequest): number {
  const chars = req.messages.reduce((sum, m) => sum + messageText(m.content).length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * An in-process provider whose timing and failures come from config, so every failure scenario
 * can be triggered on purpose. All waiting goes through the injected clock.
 */
export class MockProvider implements Provider {
  readonly kind = 'mock' as const;
  readonly #settings: MockSettings;
  readonly #clock: Clock;
  readonly #random: () => number;
  readonly #stats: MockStats = {
    requests: 0,
    active: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    tokensEmitted: 0,
  };

  constructor(settings: MockSettings, clock: Clock) {
    this.#settings = settings;
    this.#clock = clock;
    this.#random = seededRandom(settings.seed);
  }

  stats(): MockStats {
    return { ...this.#stats };
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const plan = this.#plan(req);
    this.#begin();
    let outcome: Outcome = 'canceled';
    try {
      await this.#clock.sleep(this.#settings.latencyMs, signal);
      this.#failIfConfigured();
      if (plan.dropAfter !== undefined) throw dropped(plan.dropAfter);
      const content = plan.tokens.join('');
      this.#stats.tokensEmitted += plan.tokens.length;
      outcome = 'completed';
      return { content, finishReason: plan.finishReason, usage: plan.usage };
    } catch (err) {
      outcome = signal.aborted ? 'canceled' : 'failed';
      throw err;
    } finally {
      this.#end(outcome);
    }
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const plan = this.#plan(req);
    const interval =
      this.#settings.tokensPerSecond === undefined ? 0 : 1000 / this.#settings.tokensPerSecond;
    this.#begin();
    // Stays 'canceled' if the consumer stops early without the signal firing.
    let outcome: Outcome = 'canceled';
    try {
      await this.#clock.sleep(this.#settings.ttftMs, signal);
      this.#failIfConfigured();
      for (let i = 0; i < plan.tokens.length; i++) {
        if (i === plan.dropAfter) throw dropped(i);
        if (i > 0 && interval > 0) await this.#clock.sleep(interval, signal);
        this.#stats.tokensEmitted++;
        yield { type: 'content', text: plan.tokens[i]! };
      }
      outcome = 'completed';
      yield { type: 'finish', finishReason: plan.finishReason, usage: plan.usage };
    } catch (err) {
      outcome = signal.aborted ? 'canceled' : 'failed';
      throw err;
    } finally {
      this.#end(outcome);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  #plan(req: ChatRequest): Plan {
    const wanted = this.#settings.completionTokens;
    const count = Math.min(wanted, req.maxTokens ?? wanted);
    const tokens = Array.from(
      { length: count },
      (_, i) => (i === 0 ? '' : ' ') + WORDS[i % WORDS.length]!,
    );
    const promptTokens = estimatePromptTokens(req);
    const drop = this.#settings.dropAfterTokens;
    return {
      tokens,
      finishReason: count < wanted ? 'length' : 'stop',
      usage: { promptTokens, completionTokens: count, totalTokens: promptTokens + count },
      dropAfter: drop !== undefined && drop < count ? drop : undefined,
    };
  }

  #failIfConfigured(): void {
    const { failWith, errorRate, retryAfterMs } = this.#settings;
    if (failWith === 429) {
      throw new ProviderError('rate_limited', 'mock forced 429', {
        upstreamStatus: 429,
        retryAfterMs,
      });
    }
    if (failWith === 500 || (errorRate > 0 && this.#random() < errorRate)) {
      throw new ProviderError('server_error', 'mock forced 500', { upstreamStatus: 500 });
    }
  }

  #begin(): void {
    this.#stats.requests++;
    this.#stats.active++;
  }

  #end(outcome: Outcome): void {
    this.#stats.active--;
    this.#stats[outcome]++;
  }
}

type Outcome = 'completed' | 'failed' | 'canceled';

interface Plan {
  tokens: string[];
  finishReason: FinishReason;
  usage: Usage;
  dropAfter: number | undefined;
}

function dropped(afterTokens: number): ProviderError {
  return new ProviderError('connection', `mock dropped the connection after ${afterTokens} tokens`);
}
