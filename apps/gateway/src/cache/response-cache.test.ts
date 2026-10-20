import { describe, expect, it } from 'vitest';
import type { ChatCompletionRequest } from '../proxy/schema.js';
import { cacheable, cacheKey } from './response-cache.js';

const base: ChatCompletionRequest = {
  model: 'mock-1',
  messages: [{ role: 'user', content: 'Say hello' }],
  temperature: 0,
};
const project = '0192f000-0000-7000-8000-00000000000a';
const other = '0192f000-0000-7000-8000-00000000000b';

describe('cacheKey', () => {
  it('never matches across projects', () => {
    expect(cacheKey(project, base)).not.toBe(cacheKey(other, base));
  });

  it('ignores fields that cannot change the answer', () => {
    const key = cacheKey(project, base);
    expect(cacheKey(project, { ...base, stream: true, user: 'u-1' })).toBe(key);
    expect(cacheKey(project, { ...base, stream_options: { include_usage: true } })).toBe(key);
  });

  it('treats equal content the same however it is written', () => {
    const parts: ChatCompletionRequest = {
      ...base,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }],
    };
    expect(cacheKey(project, parts)).toBe(cacheKey(project, base));
    expect(cacheKey(project, { ...base, stop: 'x' })).toBe(
      cacheKey(project, { ...base, stop: ['x'] }),
    );
    expect(cacheKey(project, { ...base, max_tokens: 5 })).toBe(
      cacheKey(project, { ...base, max_completion_tokens: 5 }),
    );
  });

  it('changes with anything that changes the answer', () => {
    const key = cacheKey(project, base);
    const variants: Partial<ChatCompletionRequest>[] = [
      { model: 'mock-2' },
      { messages: [{ role: 'user', content: 'Say goodbye' }] },
      { messages: [{ role: 'system', content: 'Say hello' }] },
      { messages: [{ role: 'user', content: 'Say hello', name: 'n' }] },
      { max_tokens: 5 },
      { temperature: 0.1 },
      { top_p: 0.5 },
      { stop: ['.'] },
      { seed: 7 },
      { presence_penalty: 1 },
      { frequency_penalty: 1 },
    ];
    const keys = variants.map((v) => cacheKey(project, { ...base, ...v }));
    expect(new Set([key, ...keys]).size).toBe(variants.length + 1);
  });
});

describe('cacheable', () => {
  it('caches deterministic requests unless told not to', () => {
    expect(cacheable(base, undefined)).toBe(true);
    expect(cacheable(base, 'off')).toBe(false);
  });

  it('caches sampled requests only when the caller opts in', () => {
    expect(cacheable({ ...base, temperature: 0.7 }, undefined)).toBe(false);
    expect(cacheable({ ...base, temperature: undefined }, undefined)).toBe(false);
    expect(cacheable({ ...base, temperature: 0.7 }, 'on')).toBe(true);
  });
});
