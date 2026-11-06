import { createHash, randomBytes } from 'node:crypto';
import { ProviderError } from './errors.js';
import type { ChatResult, StreamEvent, ToolCall } from './types.js';

/** A fresh tool-call ID in OpenAI's style, for providers that send none. */
export function newToolCallId(): string {
  return `call_${randomBytes(12).toString('hex')}`;
}

/** A piece of a tool call as a provider sends it: any field may be missing. */
export interface ToolCallDelta {
  index?: number | null | undefined;
  id?: string | null | undefined;
  name?: string | null | undefined;
  arguments?: string | null | undefined;
}

interface Building {
  /** Position among the answer's calls, from 0, in the order they first appeared. */
  index: number;
  id: string | undefined;
  name: string | undefined;
  args: string[];
  /** Arguments that came before the name, sent once the call has started. */
  early: string[];
  started: boolean;
}

/**
 * Assembles a provider's tool calls into the gateway's stream events, whatever form they come in:
 * OpenAI's pieces (index, ID and name first, then arguments), a whole call in one chunk, pieces
 * without an `index`, or a call with no ID (one is generated). Every call's `tool_call` event,
 * with its ID and name, comes before its `tool_arguments` events, and calls are numbered from 0 in
 * the order they first appeared. Non-streamed answers go through it too, as one delta per call.
 */
export class ToolCallAssembler {
  readonly #newId: () => string;
  /** Calls by the provider's own `index`. */
  readonly #byIndex = new Map<number, Building>();
  readonly #calls: Building[] = [];

  constructor(newId: () => string = newToolCallId) {
    this.#newId = newId;
  }

  /** Takes one delta; returns the events it completes, in order. */
  push(delta: ToolCallDelta): StreamEvent[] {
    const call = this.#callFor(delta);
    if (delta.id && call.id === undefined) call.id = delta.id;
    if (delta.name && call.name === undefined) call.name = delta.name;
    const events: StreamEvent[] = [];
    if (delta.arguments) {
      if (call.started) {
        call.args.push(delta.arguments);
        events.push({ type: 'tool_arguments', index: call.index, text: delta.arguments });
      } else {
        call.early.push(delta.arguments);
      }
    }
    if (!call.started && call.name !== undefined) {
      call.started = true;
      call.id ??= this.#newId();
      events.push({ type: 'tool_call', index: call.index, id: call.id, name: call.name });
      if (call.early.length > 0) {
        const text = call.early.join('');
        call.args.push(text);
        call.early = [];
        events.push({ type: 'tool_arguments', index: call.index, text });
      }
    }
    return events;
  }

  /** The calls assembled so far. Throws if one never got a function name. */
  calls(): ToolCall[] {
    return this.#calls.map((call) => {
      if (!call.started || call.id === undefined || call.name === undefined) {
        throw new ProviderError('invalid_response', 'upstream sent a tool call without a name');
      }
      return { id: call.id, name: call.name, arguments: call.args.join('') };
    });
  }

  get count(): number {
    return this.#calls.length;
  }

  #callFor(delta: ToolCallDelta): Building {
    if (typeof delta.index === 'number') {
      const known = this.#byIndex.get(delta.index);
      if (known) return known;
      const call = this.#start();
      this.#byIndex.set(delta.index, call);
      return call;
    }
    // No index: a new ID, or a name for a call that already has one, starts the next call;
    // anything else continues the last one.
    const last = this.#calls.at(-1);
    if (
      !last ||
      (delta.id && last.id !== undefined && delta.id !== last.id) ||
      (delta.name && last.name !== undefined && !delta.id)
    ) {
      return this.#start();
    }
    return last;
  }

  #start(): Building {
    const call: Building = {
      index: this.#calls.length,
      id: undefined,
      name: undefined,
      args: [],
      early: [],
      started: false,
    };
    this.#calls.push(call);
    return call;
  }
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Tool-call IDs for a provider that takes only some forms (Dialect.toolCallIds). An ID that does
 * not fit is replaced, for the provider, by one derived from it that does, the same everywhere in
 * the request (assistant tool calls and tool messages); IDs in the provider's answer that are
 * replacements are turned back. Without a rule, IDs pass unchanged.
 */
export class ToolCallIdMap {
  readonly #rule: { pattern: RegExp; length: number } | undefined;
  readonly #out = new Map<string, string>();
  readonly #back = new Map<string, string>();

  constructor(rule: { pattern: RegExp; length: number } | undefined) {
    this.#rule = rule;
  }

  /** The ID to send the provider for the gateway's `id`. */
  out(id: string): string {
    const rule = this.#rule;
    if (!rule || rule.pattern.test(id)) return id;
    const known = this.#out.get(id);
    if (known) return known;
    // A hash of the ID in base 62; a collision with another replacement takes the next one.
    for (let n = 0; ; n++) {
      const digest = createHash('sha256').update(`${n}:${id}`).digest();
      const mapped = [...digest.subarray(0, rule.length)].map((b) => BASE62[b % 62]).join('');
      if (this.#back.has(mapped)) continue;
      this.#out.set(id, mapped);
      this.#back.set(mapped, id);
      return mapped;
    }
  }

  /** The gateway's ID for an ID the provider sent. */
  back(id: string): string {
    return this.#back.get(id) ?? id;
  }
}

/**
 * A whole answer as stream events, in the order a stream sends them: for a provider that cannot
 * stream a request (Dialect.streamJsonSchema), and for the mock.
 */
export function* resultEvents(result: ChatResult): Generator<StreamEvent> {
  if (result.content !== '') yield { type: 'content', text: result.content };
  for (const [index, call] of (result.toolCalls ?? []).entries()) {
    yield { type: 'tool_call', index, id: call.id, name: call.name };
    if (call.arguments !== '') yield { type: 'tool_arguments', index, text: call.arguments };
  }
  yield {
    type: 'finish',
    finishReason: result.finishReason,
    usage: result.usage,
    rateLimit: result.rateLimit,
  };
}
