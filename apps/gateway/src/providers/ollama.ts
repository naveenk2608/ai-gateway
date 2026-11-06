import type { Clock } from '@ai-gateway/shared';
import { Agent } from 'undici';
import { z } from 'zod';
import { ProviderError } from './errors.js';
import {
  MAX_RESPONSE_BYTES,
  networkError,
  parseJson,
  postJson,
  probeGet,
  readText,
} from './http.js';
import { splitLines } from './line-stream.js';
import { ToolCallAssembler } from './tool-calls.js';
import {
  messageImages,
  messageText,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type FinishReason,
  type Provider,
  type StreamEvent,
  type Usage,
} from './types.js';

export interface OllamaOptions {
  /** Server root, e.g. http://localhost:11434; `/api/chat` is appended. */
  baseUrl: string;
  clock: Clock;
  maxResponseBytes?: number;
}

// One object per response (non-streaming) or per line (streaming); untrusted, so only the fields
// we use are validated.
const toolCall = z.object({
  function: z.object({
    name: z.string(),
    arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).nullish(),
  }),
});

const chatPart = z.object({
  message: z
    .object({ content: z.string().nullish(), tool_calls: z.array(toolCall).nullish() })
    .nullish(),
  done: z.boolean(),
  done_reason: z.string().nullish(),
  prompt_eval_count: z.number().int().min(0).nullish(),
  eval_count: z.number().int().min(0).nullish(),
});

const errorLine = z.object({ error: z.string() });

type ChatPart = z.output<typeof chatPart>;

function readPart(value: unknown): ChatPart {
  if (errorLine.safeParse(value).success) {
    throw new ProviderError('server_error', 'Ollama reported an error');
  }
  const result = chatPart.safeParse(value);
  if (!result.success) {
    throw new ProviderError('invalid_response', 'Ollama response has an unexpected shape', {
      cause: result.error,
    });
  }
  return result.data;
}

function toUsage(part: ChatPart): Usage | null {
  // Ollama omits the counts in some cases (e.g. a fully cached prompt); report nothing rather
  // than a wrong number.
  if (part.prompt_eval_count == null || part.eval_count == null) return null;
  return {
    promptTokens: part.prompt_eval_count,
    completionTokens: part.eval_count,
    totalTokens: part.prompt_eval_count + part.eval_count,
  };
}

function toFinishReason(reason: string | null | undefined, calledTools: boolean): FinishReason {
  if (reason === 'length') return 'length';
  return calledTools ? 'tool_calls' : 'stop';
}

/** Ollama's tool calls carry no ID: the assembler gives each one. */
function pushCalls(calls: ToolCallAssembler, part: ChatPart) {
  return (part.message?.tool_calls ?? []).flatMap((call) =>
    calls.push({
      index: calls.count,
      name: call.function.name,
      arguments:
        typeof call.function.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {}),
    }),
  );
}

/** Arguments as the object Ollama expects; text that is not a JSON object becomes `{}`. */
function argumentsObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The base64 payload of a `data:` URL; Ollama takes no image URLs, and the gateway fetches none. */
function base64Image(url: string): string {
  const match = /^data:image\/[a-z+.-]+;base64,(.*)$/s.exec(url);
  if (!match) throw new ProviderError('bad_request', 'Ollama takes images only as data: URLs');
  return match[1]!;
}

function ollamaMessage(m: ChatMessage) {
  const images = messageImages(m.content).map((image) => base64Image(image.url));
  return {
    // Ollama has no `developer` role and takes plain-text content.
    role: m.role === 'developer' ? 'system' : m.role,
    content: messageText(m.content),
    ...(images.length > 0 ? { images } : {}),
    ...(m.toolCalls && m.toolCalls.length > 0
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: argumentsObject(c.arguments) },
          })),
        }
      : {}),
  };
}

/** Ollama's native chat API (`/api/chat`): JSON, or newline-delimited JSON when streaming. */
export class OllamaProvider implements Provider {
  readonly kind = 'ollama' as const;
  readonly #url: string;
  readonly #tagsUrl: string;
  readonly #clock: Clock;
  readonly #maxResponseBytes: number;
  readonly #agent = new Agent({ connect: { timeout: 10_000 } });

  constructor(options: OllamaOptions) {
    const root = options.baseUrl.replace(/\/+$/, '');
    this.#url = `${root}/api/chat`;
    this.#tagsUrl = `${root}/api/tags`;
    this.#clock = options.clock;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const response = await this.#post(req, false, signal);
    let text: string;
    try {
      text = await readText(response.body, this.#maxResponseBytes);
    } catch (err) {
      throw networkError(err, signal);
    }
    const part = readPart(parseJson(text));
    if (!part.done) throw new ProviderError('invalid_response', 'Ollama response is not final');
    const calls = new ToolCallAssembler();
    pushCalls(calls, part);
    const toolCalls = calls.calls();
    return {
      content: part.message?.content ?? '',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: toFinishReason(part.done_reason, toolCalls.length > 0),
      usage: toUsage(part),
    };
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.#post(req, true, signal);
    let final: ChatPart | undefined;
    const calls = new ToolCallAssembler();
    try {
      for await (const line of splitLines(response.body)) {
        if (line.trim() === '') continue;
        const part = readPart(parseJson(line));
        const text = part.message?.content;
        if (text) yield { type: 'content', text };
        yield* pushCalls(calls, part);
        if (part.done) {
          final = part;
          break;
        }
      }
    } catch (err) {
      throw networkError(err, signal);
    } finally {
      response.body.destroy();
    }
    if (!final) throw new ProviderError('connection', 'Ollama stream ended before the final line');
    yield {
      type: 'finish',
      finishReason: toFinishReason(final.done_reason, calls.count > 0),
      usage: toUsage(final),
    };
  }

  /** Lists local models: the server is up and answering. */
  probe(signal: AbortSignal): Promise<void> {
    return probeGet(this.#tagsUrl, { agent: this.#agent, headers: {}, signal, clock: this.#clock });
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }

  #post(req: ChatRequest, stream: boolean, signal: AbortSignal) {
    const format = req.responseFormat;
    const body = {
      model: req.model,
      messages: req.messages.map(ollamaMessage),
      stream,
      // No tool_choice in Ollama's API: a request with tools lets the model decide (`auto`).
      tools: req.tools?.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      format:
        format?.type === 'json_object'
          ? 'json'
          : format?.type === 'json_schema'
            ? (format.schema ?? 'json')
            : undefined,
      options: {
        num_predict: req.maxTokens,
        temperature: req.temperature,
        top_p: req.topP,
        stop: req.stop,
        presence_penalty: req.presencePenalty,
        frequency_penalty: req.frequencyPenalty,
        seed: req.seed,
      },
    };
    return postJson(this.#url, body, {
      agent: this.#agent,
      headers: {
        accept: stream ? 'application/x-ndjson' : 'application/json',
        ...(req.traceparent ? { traceparent: req.traceparent } : {}),
      },
      signal,
      clock: this.#clock,
    });
  }
}
