import { createHash } from 'node:crypto';
import { estimateTextTokens, type Clock } from '@ai-gateway/shared';
import { ProviderError } from './errors.js';
import {
  messageText,
  type ChatRequest,
  type ChatResult,
  type EmbeddingRequest,
  type EmbeddingResult,
  type FinishReason,
  type Provider,
  type StreamEvent,
  type ToolCall,
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
  /** Prompt tokens to report instead of the mock's own estimate (e.g. more than the gateway's). */
  promptTokens?: number | undefined;
  /** Probability (0..1) that a request fails with a 500, drawn from a seeded RNG. */
  errorRate: number;
  seed: number;
  /** Fail every request with this status. */
  failWith?: 429 | 500 | undefined;
  /** Retry-After sent with forced 429s. */
  retryAfterMs: number;
  /** Streaming: drop the connection after this many tokens. Non-streaming: fail mid-response. */
  dropAfterTokens?: number | undefined;
  /** Embeddings: the vectors' size when the request sets none (the deployment's dimensions). */
  embeddingDimensions?: number | undefined;
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

/**
 * A value that a JSON Schema accepts, made the same way each time: every required property of an
 * object, the fewest array items allowed, the first `enum` value or `anyOf`/`oneOf` branch, and a
 * fixed value of each type. `$ref` and pattern constraints are not followed.
 */
export function sampleFor(schema: unknown, depth = 0): unknown {
  if (depth > 16 || typeof schema !== 'object' || schema === null) return null;
  const s = schema as Record<string, unknown>;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = s[key];
    if (Array.isArray(branches) && branches.length > 0) return sampleFor(branches[0], depth + 1);
  }
  const type = Array.isArray(s.type)
    ? ((s.type as unknown[]).find((t) => t !== 'null') ?? 'null')
    : (s.type ?? (s.properties ? 'object' : undefined));
  const minimum = typeof s.minimum === 'number' ? s.minimum : 0;
  switch (type) {
    case 'object': {
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(s.required) ? (s.required as unknown[]) : [];
      return Object.fromEntries(
        required
          .filter((key): key is string => typeof key === 'string')
          .map((key) => [key, sampleFor(properties[key], depth + 1)]),
      );
    }
    case 'array': {
      const count = typeof s.minItems === 'number' ? s.minItems : 0;
      return Array.from({ length: count }, () => sampleFor(s.items, depth + 1));
    }
    case 'string':
      return 'mock'.padEnd(typeof s.minLength === 'number' ? s.minLength : 0, 'k');
    case 'integer':
      return Math.ceil(minimum);
    case 'number':
      return minimum;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

/** The tool call the mock makes for a request, if any (see MockProvider). */
function plannedToolCall(req: ChatRequest): ToolCall | undefined {
  const tools = req.tools ?? [];
  const choice = req.toolChoice ?? 'auto';
  if (tools.length === 0 || choice === 'none') return undefined;
  // With `auto`, a tool result ends the loop: the mock answers it in text.
  if (choice === 'auto' && req.messages.at(-1)?.role === 'tool') return undefined;
  const tool =
    (typeof choice === 'object' ? tools.find((t) => t.name === choice.name) : undefined) ??
    tools[0]!;
  const id = createHash('sha256')
    .update(`${req.messages.length}:${tool.name}`)
    .digest('hex')
    .slice(0, 24);
  return {
    id: `call_${id}`,
    name: tool.name,
    arguments: JSON.stringify(sampleFor(tool.parameters ?? { type: 'object' })),
  };
}

/** The JSON the mock answers with when the request asks for JSON output. */
function plannedJson(req: ChatRequest): string | undefined {
  const format = req.responseFormat;
  if (format?.type === 'json_schema') return JSON.stringify(sampleFor(format.schema ?? {}));
  if (format?.type === 'json_object') return JSON.stringify({ response: WORDS.join(' ') });
  return undefined;
}

/**
 * The mock's embedding of a text: the same text always gives the same vector of unit length,
 * drawn from a PRNG seeded with a hash of the text.
 */
export function mockVector(text: string, size: number): number[] {
  const random = seededRandom(createHash('sha256').update(text).digest().readUInt32BE(0));
  const vector = Array.from({ length: size }, () => random() * 2 - 1);
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return vector.map((x) => x / norm);
}

/** Rough prompt size: about four characters per token. */
function estimatePromptTokens(req: ChatRequest): number {
  const chars = req.messages.reduce((sum, m) => sum + messageText(m.content).length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * An in-process provider whose timing and failures come from config, so every failure scenario
 * can be triggered on purpose. All waiting goes through the injected clock.
 *
 * With tools, it calls one (ADR 028): the named tool, else the first, with arguments that fill
 * the schema's required fields, unless `tool_choice` is `none`, or it is `auto` and the last
 * message is a tool result (then it answers in text, so a tool-calling loop ends). With a JSON
 * response format it answers JSON that matches the schema.
 */
export class MockProvider implements Provider {
  readonly kind = 'mock' as const;
  #settings: MockSettings;
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

  /** Changes settings at runtime, e.g. to make a deployment fail and then heal (tests, demos). */
  update(settings: Partial<MockSettings>): void {
    this.#settings = { ...this.#settings, ...settings };
  }

  /** Healthy unless every request is set to fail (a forced status or an error rate of 1). */
  probe(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new ProviderError('canceled', 'probe aborted'));
    const { failWith, errorRate } = this.#settings;
    if (failWith !== undefined || errorRate >= 1) {
      return Promise.reject(
        new ProviderError('server_error', 'mock is failing', { upstreamStatus: failWith ?? 500 }),
      );
    }
    return Promise.resolve();
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
      return {
        content,
        ...(plan.toolCall ? { toolCalls: [plan.toolCall] } : {}),
        finishReason: plan.finishReason,
        usage: plan.usage,
      };
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
      const call = plan.toolCall;
      if (call) {
        // The arguments in two pieces, as providers stream them.
        const half = Math.ceil(call.arguments.length / 2);
        yield { type: 'tool_call', index: 0, id: call.id, name: call.name };
        for (const text of [call.arguments.slice(0, half), call.arguments.slice(half)]) {
          if (text !== '') yield { type: 'tool_arguments', index: 0, text };
        }
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

  /** Deterministic unit vectors (mockVector), after `latencyMs`, failing as configured. */
  async embed(req: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult> {
    this.#begin();
    let outcome: Outcome = 'canceled';
    try {
      await this.#clock.sleep(this.#settings.latencyMs, signal);
      this.#failIfConfigured();
      const size = req.dimensions ?? this.#settings.embeddingDimensions ?? 8;
      const promptTokens = req.input.reduce(
        (n, text) => n + Math.max(1, estimateTextTokens(text)),
        0,
      );
      outcome = 'completed';
      return {
        vectors: req.input.map((text) => mockVector(text, size)),
        usage: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
      };
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
    const promptTokens = this.#settings.promptTokens ?? estimatePromptTokens(req);
    const toolCall = plannedToolCall(req);
    const json = toolCall ? undefined : plannedJson(req);
    if (toolCall || json !== undefined) {
      // Whole, whatever the output cap: a cut call or JSON would be useless to a test.
      const text = toolCall ? toolCall.name + toolCall.arguments : (json ?? '');
      const completionTokens = Math.max(1, estimateTextTokens(text));
      const tokens = json === undefined ? [] : (json.match(/.{1,8}/gs) ?? []);
      return {
        tokens,
        toolCall,
        finishReason: toolCall ? 'tool_calls' : 'stop',
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        dropAfter: undefined,
      };
    }
    const wanted = this.#settings.completionTokens;
    const count = Math.min(wanted, req.maxTokens ?? wanted);
    const tokens = Array.from(
      { length: count },
      (_, i) => (i === 0 ? '' : ' ') + WORDS[i % WORDS.length]!,
    );
    const drop = this.#settings.dropAfterTokens;
    return {
      tokens,
      toolCall: undefined,
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
  /** The tool the mock calls instead of answering in text. */
  toolCall: ToolCall | undefined;
  finishReason: FinishReason;
  usage: Usage;
  dropAfter: number | undefined;
}

function dropped(afterTokens: number): ProviderError {
  return new ProviderError('connection', `mock dropped the connection after ${afterTokens} tokens`);
}
