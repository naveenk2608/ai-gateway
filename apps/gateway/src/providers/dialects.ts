import type { AdapterKind } from '../models-config.js';

/** `tool_choice` values: a forced call of one named function is `named`. */
export type ToolChoiceKind = 'none' | 'auto' | 'required' | 'named';

/**
 * What a provider's API takes of the request fields the gateway accepts, from the provider's own
 * docs (docs/providers.md lists each difference with its source). An adapter drops a field the
 * provider does not take when the request still means the same without it in practice (`strict`
 * on tools, `parallel_tool_calls`), and maps tool-call IDs the provider would refuse. What it
 * cannot adapt (a `tool_choice` value, images by URL, structured output with tools) makes the
 * deployment unfit for that request, so capability routing skips it (ADR 028).
 */
export interface Dialect {
  /** The `tool_choice` values the provider documents. `auto` is always among them. */
  toolChoices: ReadonlySet<ToolChoiceKind>;
  /** Sends `parallel_tool_calls`; otherwise it is dropped. */
  parallelToolCalls: boolean;
  /** Sends `strict` in function definitions; otherwise it is dropped. */
  toolStrict: boolean;
  /** Takes images by `https:` URL; otherwise only `data:` URLs (the gateway never fetches URLs). */
  imageUrls: boolean;
  /**
   * The tool-call IDs the provider takes; an ID that does not match is replaced by one that does
   * (derived from it) for the call, and replaced back in the answer. Undefined: any string.
   */
  toolCallIds?: { pattern: RegExp; length: number } | undefined;
  /**
   * `json_schema` output may be streamed. Otherwise a streamed request is sent as one
   * non-streamed call and its answer replayed as a stream.
   */
  streamJsonSchema: boolean;
  /** `json_schema` output may be combined with tools. */
  jsonSchemaWithTools: boolean;
}

const ALL_CHOICES: ReadonlySet<ToolChoiceKind> = new Set(['none', 'auto', 'required', 'named']);
const AUTO_ONLY: ReadonlySet<ToolChoiceKind> = new Set(['auto']);

/** OpenAI's own behaviour: every field as sent. Used for providers with no entry below. */
const OPENAI: Dialect = {
  toolChoices: ALL_CHOICES,
  parallelToolCalls: true,
  toolStrict: true,
  imageUrls: true,
  streamJsonSchema: true,
  jsonSchemaWithTools: true,
};

/**
 * Differences of the OpenAI-compatible providers the models file uses, by provider name.
 * Fields a provider's docs do not mention are treated as not taken.
 */
const OPENAI_COMPATIBLE: Readonly<Record<string, Dialect>> = {
  // console.groq.com/docs (api-reference, tool-use, structured-outputs, vision), 2026-11-06:
  // tool_choice none/auto/required/named and parallel_tool_calls documented; no `strict` on
  // tools; "Streaming and tool use are not currently supported with Structured Outputs".
  groq: {
    ...OPENAI,
    toolStrict: false,
    streamJsonSchema: false,
    jsonSchemaWithTools: false,
  },
  // aistudio.google.com/docs/openai, 2026-11-06: only tool_choice "auto" is shown, no
  // parallel_tool_calls or strict, images only as base64 data URLs.
  gemini: {
    ...OPENAI,
    toolChoices: AUTO_ONLY,
    parallelToolCalls: false,
    toolStrict: false,
    imageUrls: false,
  },
  // docs.mistral.ai (api/endpoint/chat, capabilities/function_calling, vision), 2026-11-06:
  // tool_choice auto/none/any/required and a named tool, parallel_tool_calls, image URLs; no
  // `strict` on tools. Tool-call IDs: the docs state no format, but every ID they show is nine
  // letters and digits, so IDs that are not are mapped (PLAN-NOTES, M13).
  mistral: {
    ...OPENAI,
    toolStrict: false,
    toolCallIds: { pattern: /^[A-Za-z0-9]{9}$/, length: 9 },
  },
  // openrouter.ai/docs (tool-calling, image inputs), 2026-11-06: tool_choice none/auto/named
  // ("required" not documented), parallel_tool_calls, image URLs and data URLs; no `strict`.
  openrouter: {
    ...OPENAI,
    toolChoices: new Set(['none', 'auto', 'named']),
    toolStrict: false,
  },
  // docs.z.ai api-reference, 2026-11-06: "only auto is supported"; image URL or base64.
  zai: {
    ...OPENAI,
    toolChoices: AUTO_ONLY,
    parallelToolCalls: false,
    toolStrict: false,
  },
  // developers.cloudflare.com/workers-ai (OpenAI compatibility, JSON mode), 2026-11-06: tools
  // and images are not documented for the OpenAI endpoint; "JSON Mode currently doesn't support
  // streaming".
  cloudflare: {
    ...OPENAI,
    toolChoices: AUTO_ONLY,
    parallelToolCalls: false,
    toolStrict: false,
    imageUrls: false,
    streamJsonSchema: false,
  },
  // No tool, JSON or image documentation for the configured NVIDIA model (2026-11-06).
  nvidia: {
    ...OPENAI,
    toolChoices: AUTO_ONLY,
    parallelToolCalls: false,
    toolStrict: false,
    imageUrls: false,
  },
};

/**
 * Ollama's /api/chat (docs.ollama.com/api/chat, 2026-11-06): tools and `format` (JSON or a
 * schema), images as base64 only, and no tool_choice, so a request with tools is `auto`.
 */
const OLLAMA: Dialect = {
  ...OPENAI,
  toolChoices: AUTO_ONLY,
  parallelToolCalls: false,
  toolStrict: false,
  imageUrls: false,
};

/** The dialect of a deployment's provider. */
export function dialectFor(adapter: AdapterKind, provider: string): Dialect {
  if (adapter === 'ollama') return OLLAMA;
  if (adapter === 'mock') return OPENAI;
  return OPENAI_COMPATIBLE[provider] ?? OPENAI;
}
