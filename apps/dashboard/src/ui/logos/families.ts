import { LOGOS, type Logo } from './logos.js';

/**
 * Model families, from model names: who made a model, which can differ from the provider serving
 * it (Qwen or OpenAI's gpt-oss on Groq, Llama on Ollama). Shared with the Playground.
 */
export interface ModelFamily {
  /** Matches a provider id when the maker also hosts (OpenAI, Gemini). */
  id: string;
  name: string;
  logo: Logo;
}

const FAMILIES: (ModelFamily & { pattern: RegExp })[] = [
  // OpenAI's own names, and its open-weight gpt-oss models wherever they are hosted.
  {
    id: 'openai',
    name: 'OpenAI',
    logo: LOGOS.openai,
    pattern: /gpt-oss|(^|\/)(gpt-|chatgpt-|o\d)/,
  },
  { id: 'qwen', name: 'Qwen', logo: LOGOS.qwen, pattern: /qwen/ },
  { id: 'meta', name: 'Llama', logo: LOGOS.meta, pattern: /llama/ },
  { id: 'gemini', name: 'Gemini', logo: LOGOS.gemini, pattern: /gemini/ },
];

/** The family of a model, from its name (`qwen/qwen3.8-27b`, `llama3.2:1b`); null if unknown. */
export function modelFamily(model: string | null | undefined): ModelFamily | null {
  const name = (model ?? '').toLowerCase();
  const found = FAMILIES.find((f) => f.pattern.test(name));
  return found ? { id: found.id, name: found.name, logo: found.logo } : null;
}
