/**
 * Token counts estimated without the model's tokenizer, for limits and budgets before a call and
 * for `estimated` usage when a provider reports none. Byte-pair tokenizers split text into words,
 * number groups and punctuation runs, then split long words further; this follows the same
 * pre-split and charges one token per five letters of a word, one per character of scripts
 * written without spaces (CJK), one per three digits and one per two symbols. It leans high for
 * English prose, the safe side for reservations; the gap to reported usage is stored per request.
 */

const PIECE =
  /([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]+)|(\p{L}+)|(\p{N}+)|(\n+)|([^\s\p{L}\p{N}]+)/gu;

const codePoints = (text: string) => [...text].length;

/** Approximate tokens in a piece of text. */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const [, cjk, word, digits, newlines, symbols] of text.matchAll(PIECE)) {
    if (cjk) tokens += codePoints(cjk);
    else if (word) tokens += Math.ceil(codePoints(word) / 5);
    else if (digits) tokens += Math.ceil(digits.length / 3);
    else if (newlines) tokens += 1;
    else if (symbols) tokens += Math.ceil(codePoints(symbols) / 2);
  }
  return tokens;
}

/** Framing tokens chat models add per message, and once to prime the reply (OpenAI's counts). */
const PER_MESSAGE = 3;
const PER_NAME = 1;
const REPLY_PRIMING = 3;

export interface EstimatedMessage {
  /** The message text (text parts joined). */
  text: string;
  name?: string | undefined;
}

/** Approximate prompt tokens for a chat request, including per-message framing. */
export function estimatePromptTokens(messages: readonly EstimatedMessage[]): number {
  let tokens = REPLY_PRIMING;
  for (const message of messages) {
    tokens += PER_MESSAGE + estimateTextTokens(message.text);
    if (message.name !== undefined) tokens += PER_NAME + estimateTextTokens(message.name);
  }
  return tokens;
}
