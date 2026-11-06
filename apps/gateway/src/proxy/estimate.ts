import { estimatePromptTokens, estimateTextTokens } from '@ai-gateway/shared';
import { messageImages, messageText, type ChatRequest } from '../providers/types.js';

/**
 * Tokens counted for each image before the call, whatever its size or `detail`: Groq documents
 * 2,048 tokens per image for its vision model (console.groq.com/docs/vision, 2026-11-06), more
 * than OpenAI's or Gemini's tiles for a typical image. Only limits and budget reservations use it;
 * billing uses the usage the provider reports.
 */
export const IMAGE_TOKEN_ESTIMATE = 2_048;

/**
 * The prompt-token estimate for a chat request (ADR 008, ADR 009): every message's text, the tool
 * calls and results it holds, a fixed count per image, and the JSON of the tool definitions and
 * of a `json_schema` response format, which providers put in the prompt too.
 */
export function estimateChatPromptTokens(
  req: Pick<ChatRequest, 'messages' | 'tools' | 'responseFormat'>,
): number {
  let images = 0;
  const messages = req.messages.map((m) => {
    images += messageImages(m.content).length;
    const calls = (m.toolCalls ?? []).map((call) => `${call.name} ${call.arguments}`);
    return { text: [messageText(m.content), ...calls].join('\n'), name: m.name };
  });
  let tokens = estimatePromptTokens(messages) + images * IMAGE_TOKEN_ESTIMATE;
  if (req.tools && req.tools.length > 0) tokens += estimateTextTokens(JSON.stringify(req.tools));
  if (req.responseFormat?.type === 'json_schema') {
    tokens += estimateTextTokens(JSON.stringify(req.responseFormat));
  }
  return tokens;
}
