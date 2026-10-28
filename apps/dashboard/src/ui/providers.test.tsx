// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderBadge } from './ProviderBadge.js';
import { identifyProvider, unknownProvider } from './providers.js';

afterEach(cleanup);

const name = (facts: Parameters<typeof identifyProvider>[0]) => identifyProvider(facts).name;

describe('identifyProvider', () => {
  it('names the shipped deployments from their kind, id and model', () => {
    expect(
      name({
        provider: 'openai-compatible',
        deployment: 'groq-gpt-oss-20b',
        model: 'openai/gpt-oss-20b',
      }),
    ).toBe('Groq');
    expect(
      name({
        provider: 'openai-compatible',
        deployment: 'gemini-3.5-flash-lite',
        model: 'gemini-3.5-flash-lite',
      }),
    ).toBe('Gemini');
    expect(name({ provider: 'ollama', deployment: 'ollama-llama3.2', model: 'llama3.2:1b' })).toBe(
      'Ollama',
    );
    expect(name({ provider: 'mock', deployment: 'mock-error' })).toBe('Mock');
  });

  it('goes by the deployment id before the model: an "openai/…" model on Groq is Groq', () => {
    expect(
      name({ provider: 'openai-compatible', deployment: 'groq', model: 'openai/gpt-oss-120b' }),
    ).toBe('Groq');
  });

  it('falls back to the model name when the id says nothing', () => {
    expect(
      name({ provider: 'openai-compatible', deployment: 'fast', model: 'gemini-2.5-pro' }),
    ).toBe('Gemini');
    expect(name({ provider: 'openai-compatible', deployment: 'chat', model: 'o4-mini' })).toBe(
      'OpenAI',
    );
    // Open-weight models named "openai/…" are served by others: not a guess at OpenAI.
    expect(
      name({ provider: 'openai-compatible', deployment: 'chat', model: 'openai/gpt-oss-20b' }),
    ).toBe('OpenAI-compatible');
  });

  it('does not match a provider name inside another word', () => {
    expect(name({ provider: 'openai-compatible', deployment: 'groqish-proxy' })).toBe(
      'OpenAI-compatible',
    );
  });

  it('names a provider that is not configured yet, such as an added OpenAI deployment', () => {
    expect(name({ provider: 'openai-compatible', deployment: 'openai-chat', model: 'gpt-x' })).toBe(
      'OpenAI',
    );
  });

  it('names Qwen served by Groq as Groq, from the deployment id', () => {
    expect(
      name({
        provider: 'openai-compatible',
        deployment: 'groq-qwen3.8-27b',
        model: 'qwen/qwen3.8-27b',
      }),
    ).toBe('Groq');
  });

  it('treats an openai-compatible mock server as the mock', () => {
    expect(name({ provider: 'openai-compatible', deployment: 'mock-http', model: 'mock' })).toBe(
      'Mock',
    );
  });

  it('gives an unknown openai-compatible deployment or kind a neutral initials tile', () => {
    const hosted = identifyProvider({ provider: 'openai-compatible', deployment: 'acme-large' });
    expect(hosted).toMatchObject({ id: 'unknown:OpenAI-compatible', initials: 'OP' });
    expect(hosted.logo).toBeUndefined();
    const other = identifyProvider({ provider: 'bedrock' });
    expect(other).toMatchObject({ name: 'bedrock', initials: 'BE' });
  });

  it('keeps every provider on a chart colour token, the same one every time', () => {
    for (const facts of [
      { provider: 'mock' },
      { provider: 'ollama' },
      { provider: 'openai-compatible', deployment: 'groq-x' },
      { provider: 'something-else' },
    ]) {
      expect(identifyProvider(facts).color).toMatch(/^var\(--chart-[1-5]\)$/);
      expect(identifyProvider(facts).color).toBe(identifyProvider(facts).color);
    }
  });
});

describe('unknownProvider', () => {
  it('uses up to two letters or digits of the name, upper-cased', () => {
    expect(unknownProvider('acme').initials).toBe('AC');
    expect(unknownProvider('a').initials).toBe('A');
    expect(unknownProvider('--').initials).toBe('?');
  });
});

describe('ProviderBadge', () => {
  it('shows an initials tile and the name when there is no logo', () => {
    render(<ProviderBadge provider={identifyProvider({ provider: 'mock' })} />);
    const badge = screen.getByTitle('Mock');
    expect(badge.textContent).toBe('MOMock');
    expect(badge.querySelector('img')).toBeNull();
    expect(badge.querySelector('.provider-initials')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows a logo as a decorative image next to the name when one is set', () => {
    render(<ProviderBadge provider={{ ...unknownProvider('acme'), logo: '/acme.svg' }} />);
    const badge = screen.getByTitle('acme');
    expect(badge.querySelector('img')?.getAttribute('src')).toBe('/acme.svg');
    expect(badge.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(badge.querySelector('.provider-initials')).toBeNull();
    expect(screen.getByText('acme')).toBeTruthy();
  });
});
