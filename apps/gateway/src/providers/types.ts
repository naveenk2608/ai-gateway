/**
 * The provider seam. Every upstream (mock, Ollama, OpenAI-compatible) is called through this
 * interface with the same normalized request, results and errors.
 */

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | TextPart[];
  name?: string;
}

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
  /**
   * W3C `traceparent` naming this attempt's span (ADR 017). HTTP adapters send it as a header,
   * never in the body.
   */
  traceparent?: string;
}

export type FinishReason = 'stop' | 'length' | 'content_filter';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  finishReason: FinishReason;
  /** Null when the provider did not report usage. */
  usage: Usage | null;
}

/**
 * Stream events. A stream that ends normally always ends with exactly one `finish` event; ending
 * without one means the upstream was interrupted, and adapters throw instead.
 */
export type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage | null };

export type ProviderKind = 'mock' | 'ollama' | 'openai-compatible';

export interface Provider {
  readonly kind: ProviderKind;
  /** Resolves with the full completion. Rejects with a ProviderError; honours `signal`. */
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  /** Yields stream events. Throws a ProviderError; stops promptly when `signal` aborts. */
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  /**
   * A cheap health check that runs no model, so it costs nothing on paid APIs (ADR 012). Resolves
   * when the upstream answers; rejects with a ProviderError.
   */
  probe(signal: AbortSignal): Promise<void>;
  /** Releases connections. Called once at shutdown. */
  close(): Promise<void>;
}

/** The text of a message, with text parts joined by newlines. */
export function messageText(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('\n');
}
