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
import {
  messageText,
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
const chatPart = z.object({
  message: z.object({ content: z.string() }).nullish(),
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

function toFinishReason(reason: string | null | undefined): FinishReason {
  return reason === 'length' ? 'length' : 'stop';
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
    return {
      content: part.message?.content ?? '',
      finishReason: toFinishReason(part.done_reason),
      usage: toUsage(part),
    };
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.#post(req, true, signal);
    let final: ChatPart | undefined;
    try {
      for await (const line of splitLines(response.body)) {
        if (line.trim() === '') continue;
        const part = readPart(parseJson(line));
        const text = part.message?.content;
        if (text) yield { type: 'content', text };
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
      finishReason: toFinishReason(final.done_reason),
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
    const body = {
      model: req.model,
      // Ollama has no `developer` role and takes plain-text content.
      messages: req.messages.map((m) => ({
        role: m.role === 'developer' ? 'system' : m.role,
        content: messageText(m.content),
      })),
      stream,
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
      headers: { accept: stream ? 'application/x-ndjson' : 'application/json' },
      signal,
      clock: this.#clock,
    });
  }
}
