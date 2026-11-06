import type { Clock } from '@ai-gateway/shared';
import { Agent } from 'undici';
import { z } from 'zod';
import { ProviderError } from './errors.js';
import {
  attachUpstreamDetail,
  MAX_RESPONSE_BYTES,
  networkError,
  parseJson,
  postJson,
  probeGet,
  rateLimitHeaders,
  readText,
} from './http.js';
import { parseSse } from './line-stream.js';
import { dialectFor, type Dialect } from './dialects.js';
import { resultEvents, ToolCallAssembler, ToolCallIdMap } from './tool-calls.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  EmbeddingRequest,
  EmbeddingResult,
  FinishReason,
  Provider,
  ResponseFormat,
  StreamEvent,
  ToolChoice,
  Usage,
} from './types.js';

export interface OpenAICompatibleOptions {
  /** API root, e.g. https://api.groq.com/openai/v1; `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  clock: Clock;
  maxResponseBytes?: number;
  /** What the provider takes of the gateway's fields (dialects.ts); OpenAI's by default. */
  dialect?: Dialect;
}

const wireUsage = z.object({
  prompt_tokens: z.number().int().min(0),
  completion_tokens: z.number().int().min(0),
  total_tokens: z.number().int().min(0).optional(),
});

// A string, or a list of parts (Mistral's reasoning models: `text` parts and `thinking` parts,
// whose reasoning sits in parts of their own and has no `text`).
const wireContent = z
  .union([z.string(), z.array(z.object({ type: z.string(), text: z.string().nullish() }))])
  .nullish();

// A tool call, whole or as a streamed piece. Arguments are JSON text, or an object from
// providers that send them parsed.
const wireToolCall = z.object({
  index: z.number().int().min(0).nullish(),
  id: z.string().nullish(),
  function: z
    .object({
      name: z.string().nullish(),
      arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
    })
    .nullish(),
});

// Upstream payloads are untrusted: validate only the fields we use and ignore the rest.
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: wireContent, tool_calls: z.array(wireToolCall).nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: wireUsage.nullish(),
});

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({ content: wireContent, tool_calls: z.array(wireToolCall).nullish() })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .default([]),
  usage: wireUsage.nullish(),
});

const streamErrorSchema = z.object({ error: z.unknown() });

// OpenAI's embeddings answer: one vector per input, with its index.
const embeddingsSchema = z.object({
  data: z
    .array(z.object({ index: z.number().int().min(0).nullish(), embedding: z.array(z.number()) }))
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0),
      total_tokens: z.number().int().min(0).nullish(),
    })
    .nullish(),
});

function toUsage(usage: z.output<typeof wireUsage> | null | undefined): Usage | null {
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
  };
}

/** The reply text: text parts joined; thinking and other parts are not part of the reply. */
function toText(content: z.output<typeof wireContent>): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/** A model that called tools finished with `tool_calls`, whatever the provider says, unless cut. */
export function toFinishReason(
  reason: string | null | undefined,
  calledTools = false,
): FinishReason {
  if (reason === 'length' || reason === 'content_filter') return reason;
  return calledTools || reason === 'tool_calls' ? 'tool_calls' : 'stop';
}

function argumentsText(value: string | Record<string, unknown> | null | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toDelta(call: z.output<typeof wireToolCall>, fallbackIndex?: number) {
  return {
    index: call.index ?? fallbackIndex,
    id: call.id,
    name: call.function?.name,
    arguments: argumentsText(call.function?.arguments),
  };
}

/** A message in OpenAI's wire format, with tool-call IDs the provider takes. */
function wireMessage(m: ChatMessage, ids: ToolCallIdMap) {
  const content =
    m.content === null || typeof m.content === 'string'
      ? m.content
      : m.content.map((part) =>
          part.type === 'text'
            ? { type: 'text', text: part.text }
            : {
                type: 'image_url',
                image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
              },
        );
  return {
    role: m.role,
    content,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.toolCalls && m.toolCalls.length > 0
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            id: ids.out(c.id),
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : {}),
    ...(m.toolCallId !== undefined ? { tool_call_id: ids.out(m.toolCallId) } : {}),
  };
}

function wireToolChoice(choice: ToolChoice | undefined) {
  if (choice === undefined || typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function wireResponseFormat(format: ResponseFormat | undefined) {
  if (format?.type !== 'json_schema') return format;
  const { type, ...json_schema } = format;
  return { type, json_schema };
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Where the shape broke (field path and the expected type), never the values: for the log.
    const issue = result.error.issues[0];
    const where = issue
      ? ` at ${issue.path.map(String).join('.') || 'the top'} (${issue.code === 'invalid_type' ? `expected ${issue.expected}` : issue.code})`
      : '';
    throw new ProviderError(
      'invalid_response',
      `upstream response has an unexpected shape${where}`,
      {
        cause: result.error,
      },
    );
  }
  return result.data;
}

/**
 * Any server that speaks OpenAI's chat-completions API (ADR 004: undici, one AbortSignal per
 * attempt). Streams ask for usage in the final chunk via `stream_options.include_usage`. Fields a
 * provider does not take are adapted per its dialect (dialects.ts).
 */
export class OpenAICompatibleProvider implements Provider {
  readonly kind = 'openai-compatible' as const;
  readonly #url: string;
  readonly #embeddingsUrl: string;
  readonly #modelsUrl: string;
  readonly #apiKey: string;
  readonly #clock: Clock;
  readonly #maxResponseBytes: number;
  readonly #dialect: Dialect;
  readonly #agent = new Agent({ connect: { timeout: 10_000 } });

  constructor(options: OpenAICompatibleOptions) {
    const root = options.baseUrl.replace(/\/+$/, '');
    this.#url = `${root}/chat/completions`;
    this.#embeddingsUrl = `${root}/embeddings`;
    this.#modelsUrl = `${root}/models`;
    this.#apiKey = options.apiKey;
    this.#clock = options.clock;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.#dialect = options.dialect ?? dialectFor('openai-compatible', 'openai-compatible');
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const ids = new ToolCallIdMap(this.#dialect.toolCallIds);
    const response = await this.#post(req, false, ids, signal);
    let text: string;
    try {
      text = await readText(response.body, this.#maxResponseBytes);
    } catch (err) {
      throw networkError(err, signal);
    }
    const completion = validate(completionSchema, parseJson(text));
    const choice = completion.choices[0]!;
    const calls = new ToolCallAssembler();
    (choice.message.tool_calls ?? []).forEach((call, i) => calls.push(toDelta(call, i)));
    const toolCalls = calls.calls().map((call) => ({ ...call, id: ids.back(call.id) }));
    return {
      content: toText(choice.message.content),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: toFinishReason(choice.finish_reason, toolCalls.length > 0),
      usage: toUsage(completion.usage),
      rateLimit: rateLimitHeaders(response.headers),
    };
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    if (req.responseFormat?.type === 'json_schema' && !this.#dialect.streamJsonSchema) {
      // The provider cannot stream structured output: one plain call, replayed as a stream.
      yield* resultEvents(await this.chat(req, signal));
      return;
    }
    const ids = new ToolCallIdMap(this.#dialect.toolCallIds);
    const response = await this.#post(req, true, ids, signal);
    let finishReason: string | undefined;
    let usage: Usage | null = null;
    const calls = new ToolCallAssembler();
    try {
      for await (const { data } of parseSse(response.body)) {
        if (data === '[DONE]') break;
        const payload = parseJson(data);
        if (streamErrorSchema.safeParse(payload).success) {
          throw attachUpstreamDetail(
            new ProviderError('server_error', 'upstream reported an error mid-stream'),
            payload,
            [this.#apiKey],
            req,
          );
        }
        const chunk = validate(chunkSchema, payload);
        usage = toUsage(chunk.usage) ?? usage;
        const choice = chunk.choices[0];
        const text = toText(choice?.delta?.content);
        if (text) yield { type: 'content', text };
        for (const call of choice?.delta?.tool_calls ?? []) {
          for (const event of calls.push(toDelta(call))) {
            yield event.type === 'tool_call' ? { ...event, id: ids.back(event.id) } : event;
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      throw networkError(err, signal);
    } finally {
      // Releases the connection if we stop early (error, abort or consumer gone).
      response.body.destroy();
    }
    if (finishReason === undefined) {
      throw new ProviderError('connection', 'upstream stream ended before a finish_reason');
    }
    // Throws if a tool call never got its name.
    const calledTools = calls.calls().length > 0;
    yield {
      type: 'finish',
      finishReason: toFinishReason(finishReason, calledTools),
      usage,
      rateLimit: rateLimitHeaders(response.headers),
    };
  }

  /** `POST /embeddings` in OpenAI's format, always asking for floats (the gateway encodes). */
  async embed(req: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult> {
    const body = {
      model: req.model,
      input: req.input,
      encoding_format: 'float',
      dimensions: req.dimensions,
      user: req.user,
    };
    const response = await postJson(this.#embeddingsUrl, body, {
      agent: this.#agent,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        accept: 'application/json',
        ...(req.traceparent ? { traceparent: req.traceparent } : {}),
      },
      signal,
      clock: this.#clock,
    });
    let text: string;
    try {
      text = await readText(response.body, this.#maxResponseBytes);
    } catch (err) {
      throw networkError(err, signal);
    }
    const answer = validate(embeddingsSchema, parseJson(text));
    const data = answer.data.every((d) => typeof d.index === 'number')
      ? [...answer.data].sort((a, b) => a.index! - b.index!)
      : answer.data;
    const usage = answer.usage;
    return {
      vectors: data.map((d) => d.embedding),
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: 0,
            totalTokens: usage.total_tokens ?? usage.prompt_tokens,
          }
        : null,
      rateLimit: rateLimitHeaders(response.headers),
    };
  }

  /** Lists models: the API is up and accepts the key, and no tokens are billed. */
  probe(signal: AbortSignal): Promise<void> {
    return probeGet(this.#modelsUrl, {
      agent: this.#agent,
      headers: { authorization: `Bearer ${this.#apiKey}` },
      signal,
      clock: this.#clock,
    });
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }

  /** The request body, with what the provider does not take adapted (dialects.ts). */
  #body(req: ChatRequest, stream: boolean, ids: ToolCallIdMap) {
    const dialect = this.#dialect;
    const tools = req.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: dialect.toolStrict ? t.strict : undefined,
      },
    }));
    return {
      model: req.model,
      messages: req.messages.map((m) => wireMessage(m, ids)),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      top_p: req.topP,
      stop: req.stop,
      presence_penalty: req.presencePenalty,
      frequency_penalty: req.frequencyPenalty,
      seed: req.seed,
      user: req.user,
      tools,
      tool_choice: tools ? wireToolChoice(req.toolChoice) : undefined,
      parallel_tool_calls: tools && dialect.parallelToolCalls ? req.parallelToolCalls : undefined,
      response_format: wireResponseFormat(req.responseFormat),
    };
  }

  #post(req: ChatRequest, stream: boolean, ids: ToolCallIdMap, signal: AbortSignal) {
    return postJson(this.#url, this.#body(req, stream, ids), {
      agent: this.#agent,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        accept: stream ? 'text/event-stream' : 'application/json',
        ...(req.traceparent ? { traceparent: req.traceparent } : {}),
      },
      signal,
      clock: this.#clock,
    });
  }
}
