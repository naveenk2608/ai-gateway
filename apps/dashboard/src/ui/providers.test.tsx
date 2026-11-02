// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelLabel, ProviderBadge } from './ProviderBadge.js';
import { familyOnHost, identifyProvider, modelFamily, unknownProvider } from './providers.js';

afterEach(cleanup);

const name = (facts: Parameters<typeof identifyProvider>[0]) => identifyProvider(facts).name;

describe('identifyProvider', () => {
  it('names each provider from the name the API returns', () => {
    expect(name({ provider: 'groq', deployment: 'groq-gpt-oss-20b' })).toBe('Groq');
    expect(name({ provider: 'gemini', deployment: 'gemini-3.5-flash-lite' })).toBe('Gemini');
    expect(name({ provider: 'mistral' })).toBe('Mistral');
    expect(name({ provider: 'nvidia' })).toBe('NVIDIA');
    expect(name({ provider: 'openrouter' })).toBe('OpenRouter');
    expect(name({ provider: 'cloudflare' })).toBe('Cloudflare');
    expect(name({ provider: 'zai' })).toBe('Z.AI');
    expect(name({ provider: 'ollama', deployment: 'ollama-llama3.2', model: 'llama3.2:1b' })).toBe(
      'Ollama',
    );
    expect(name({ provider: 'mock', deployment: 'mock-error' })).toBe('Mock');
  });

  it('never guesses from the deployment id or the model name', () => {
    expect(name({ provider: 'acme', deployment: 'groq-proxy', model: 'gemini-2.5-pro' })).toBe(
      'acme',
    );
    // Rows stored before provider names existed carry the adapter kind.
    expect(
      name({ provider: 'openai-compatible', deployment: 'groq-x', model: 'gpt-4o-mini' }),
    ).toBe('OpenAI-compatible');
  });

  it('gives a provider it has no tile for a neutral initials tile', () => {
    const hosted = identifyProvider({ provider: 'openai-compatible', deployment: 'acme-large' });
    expect(hosted).toMatchObject({ id: 'unknown:OpenAI-compatible', initials: 'OP' });
    expect(hosted.logo).toBeUndefined();
    const other = identifyProvider({ provider: 'bedrock' });
    expect(other).toMatchObject({ name: 'bedrock', initials: 'BE' });
    // A name that is also an Object.prototype key is still just a name.
    expect(identifyProvider({ provider: 'constructor' })).toMatchObject({ name: 'constructor' });
  });

  it('uses letter tiles for the providers added in M11', () => {
    for (const provider of ['mistral', 'nvidia', 'openrouter', 'cloudflare', 'zai']) {
      expect(identifyProvider({ provider }).logo, provider).toBeUndefined();
    }
  });

  it('keeps every provider on a chart colour token, the same one every time', () => {
    for (const facts of [
      { provider: 'mock' },
      { provider: 'ollama' },
      { provider: 'groq' },
      { provider: 'zai' },
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

describe('modelFamily and familyOnHost', () => {
  it('names the family from the model name', () => {
    expect(modelFamily('openai/gpt-oss-20b')?.name).toBe('OpenAI');
    expect(modelFamily('groq-gpt-oss-20b')?.name).toBe('OpenAI');
    expect(modelFamily('qwen/qwen3.8-27b')?.name).toBe('Qwen');
    expect(modelFamily('llama3.2:1b')?.name).toBe('Llama');
    expect(modelFamily('gemini-3.5-flash-lite')?.name).toBe('Gemini');
    expect(modelFamily('mock')).toBeNull();
    expect(modelFamily(null)).toBeNull();
  });

  it("adds the family only when it is not the host's own", () => {
    const groq = identifyProvider({ provider: 'groq' });
    const gemini = identifyProvider({ provider: 'gemini' });
    const ollama = identifyProvider({ provider: 'ollama' });
    expect(familyOnHost(groq, 'qwen/qwen3.8-27b')?.name).toBe('Qwen');
    expect(familyOnHost(groq, 'openai/gpt-oss-20b')?.name).toBe('OpenAI');
    expect(familyOnHost(ollama, 'llama3.2:1b')?.name).toBe('Llama');
    expect(familyOnHost(gemini, 'gemini-3.5-flash-lite')).toBeNull();
  });
});

describe('ProviderBadge', () => {
  it("shows a known provider's bundled logo, decorative, next to its name", () => {
    render(<ProviderBadge provider={identifyProvider({ provider: 'gemini' })} />);
    const badge = screen.getByTitle('Gemini');
    const img = badge.querySelector('img');
    expect(decodeURIComponent(img?.getAttribute('src') ?? '')).toContain('<title>Gemini</title>');
    expect(img?.getAttribute('alt')).toBe('');
    expect(badge.querySelector('.provider-initials')).toBeNull();
    expect(badge.textContent).toBe('Gemini');
  });

  it('draws a mono logo in the text colour, so it follows the theme', () => {
    render(<ProviderBadge provider={identifyProvider({ provider: 'groq' })} />);
    const mark = screen.getByTitle('Groq').querySelector<HTMLElement>('.logo-mono');
    expect(decodeURIComponent(mark?.style.maskImage ?? '')).toContain('<title>Groq</title>');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives the mock a neutral icon, not a logo', () => {
    render(<ProviderBadge provider={identifyProvider({ provider: 'mock' })} />);
    const badge = screen.getByTitle('Mock');
    expect(badge.querySelector('.provider-icon svg')).toBeTruthy();
    expect(badge.querySelector('.logo-mark')).toBeNull();
    expect(badge.textContent).toBe('Mock');
  });

  it('keeps the letter tile for a provider it does not know', () => {
    render(
      <ProviderBadge
        provider={identifyProvider({ provider: 'openai-compatible', deployment: 'acme-large' })}
      />,
    );
    const badge = screen.getByTitle('OpenAI-compatible');
    expect(badge.querySelector('.provider-initials')?.textContent).toBe('OP');
    expect(badge.querySelector('.logo-mark')).toBeNull();
  });
});

describe('ModelLabel', () => {
  it("puts the family's logo before the name, named for screen readers", () => {
    render(<ModelLabel name="qwen3" family={modelFamily('qwen/qwen3.8-27b')} />);
    expect(screen.getByRole('img', { name: 'Qwen model' })).toBeTruthy();
    expect(screen.getByText('qwen3')).toBeTruthy();
  });

  it('is just the name without a family', () => {
    const { container } = render(<ModelLabel name="mock-1" family={null} />);
    expect(container.textContent).toBe('mock-1');
    expect(container.querySelector('.family-mark')).toBeNull();
  });
});
