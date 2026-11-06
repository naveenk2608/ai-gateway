/**
 * The provider seam. Every upstream (mock, Ollama, OpenAI-compatible) is called through this
 * interface with the same normalized request, results and errors.
 */

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

/** An image in a user message: an `https:` URL or a `data:image/...;base64,` URL. */
export interface ImagePart {
  type: 'image';
  url: string;
  detail?: 'auto' | 'low' | 'high' | undefined;
}

export type ContentPart = TextPart | ImagePart;

/** A function call the model made: `arguments` is the JSON text the model wrote. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  /** Null only on an assistant message that calls tools. */
  content: string | ContentPart[] | null;
  name?: string | undefined;
  /** Assistant messages: the tools the model called. */
  toolCalls?: ToolCall[] | undefined;
  /** Tool messages: the call this message answers. */
  toolCallId?: string | undefined;
}

/** A function the model may call; `parameters` is a JSON Schema. */
export interface ToolDefinition {
  name: string;
  description?: string | undefined;
  parameters?: Record<string, unknown> | undefined;
  strict?: boolean | undefined;
}

/** Whether, and which, tools the model must call. */
export type ToolChoice = 'none' | 'auto' | 'required' | { name: string };

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      name: string;
      description?: string | undefined;
      schema?: Record<string, unknown> | undefined;
      strict?: boolean | undefined;
    };

export interface ChatRequest {
  /** The provider's own model name (from the deployment), not the client's logical name. */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  user?: string;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  responseFormat?: ResponseFormat | undefined;
  /**
   * W3C `traceparent` naming this attempt's span (ADR 017). HTTP adapters send it as a header,
   * never in the body.
   */
  traceparent?: string;
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * The provider's own counts from `x-ratelimit-*` response headers, when it sends them (Groq
 * does). Which window each refers to differs by provider; quotas match them by their limit.
 */
export interface RateLimitHeaders {
  limitRequests?: number | undefined;
  remainingRequests?: number | undefined;
  limitTokens?: number | undefined;
  remainingTokens?: number | undefined;
}

export interface ChatResult {
  content: string;
  /** The tools the model called, in order; empty or absent when it called none. */
  toolCalls?: ToolCall[] | undefined;
  finishReason: FinishReason;
  /** Null when the provider did not report usage. */
  usage: Usage | null;
  rateLimit?: RateLimitHeaders | undefined;
}

/**
 * Stream events. A stream that ends normally always ends with exactly one `finish` event; ending
 * without one means the upstream was interrupted, and adapters throw instead.
 */
export type StreamEvent =
  | { type: 'content'; text: string }
  /** A tool call starts: always before any of its argument pieces. */
  | { type: 'tool_call'; index: number; id: string; name: string }
  /** A piece of a started tool call's arguments (JSON text). */
  | { type: 'tool_arguments'; index: number; text: string }
  | {
      type: 'finish';
      finishReason: FinishReason;
      usage: Usage | null;
      rateLimit?: RateLimitHeaders | undefined;
    };

/** An embeddings call (ADR 029): one vector per input, in order. */
export interface EmbeddingRequest {
  /** The provider's own model name (from the deployment). */
  model: string;
  input: string[];
  /** Only when the client asked for a size the deployment allows. */
  dimensions?: number | undefined;
  user?: string | undefined;
  traceparent?: string | undefined;
}

export interface EmbeddingResult {
  /** One vector per input, in the order of the inputs. */
  vectors: number[][];
  /** Input tokens as the provider counted them (completion tokens are 0); null when not sent. */
  usage: Usage | null;
  rateLimit?: RateLimitHeaders | undefined;
}

export type ProviderKind = 'mock' | 'ollama' | 'openai-compatible';

export interface Provider {
  readonly kind: ProviderKind;
  /** Resolves with the full completion. Rejects with a ProviderError; honours `signal`. */
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  /** Yields stream events. Throws a ProviderError; stops promptly when `signal` aborts. */
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  /** Embeds the inputs. Rejects with a ProviderError; honours `signal`. */
  embed(req: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingResult>;
  /**
   * A cheap health check that runs no model, so it costs nothing on paid APIs (ADR 012). Resolves
   * when the upstream answers; rejects with a ProviderError.
   */
  probe(signal: AbortSignal): Promise<void>;
  /** Releases connections. Called once at shutdown. */
  close(): Promise<void>;
}

/** The text of a message, with text parts joined by newlines; images and null add nothing. */
export function messageText(content: ChatMessage['content']): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/** The images of a message, in order. */
export function messageImages(content: ChatMessage['content']): ImagePart[] {
  if (content === null || typeof content === 'string') return [];
  return content.filter((part): part is ImagePart => part.type === 'image');
}
