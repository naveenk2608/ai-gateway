import { describe, expect, it } from 'vitest';
import { loggableMessage, MAX_UPSTREAM_MESSAGE, upstreamDetail } from './http.js';

describe('upstreamDetail', () => {
  it.each([
    [
      'OpenAI',
      { error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } },
      { code: 'rate_limit_exceeded', message: 'Rate limit reached' },
    ],
    [
      'Z.AI (numeric code as text)',
      { error: { code: '1305', message: 'Temporarily overloaded' } },
      { code: '1305', message: 'Temporarily overloaded' },
    ],
    [
      'Gemini (array, numeric code and a named status)',
      [{ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }],
      { code: 'UNAVAILABLE', message: 'The model is overloaded.' },
    ],
    [
      'OpenRouter (numeric code only)',
      { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } },
      { code: '429', message: 'Rate limit exceeded: free-models-per-day' },
    ],
    [
      'Mistral (top level)',
      {
        object: 'error',
        message: 'Capacity exceeded',
        type: 'capacity',
        param: null,
        code: '3505',
      },
      { code: '3505', message: 'Capacity exceeded' },
    ],
    [
      'NVIDIA (problem details)',
      { status: 404, title: 'Not Found', detail: 'Function not found for account' },
      { code: '404', message: 'Function not found for account' },
    ],
    ['Ollama (error as text)', { error: 'model not found' }, { message: 'model not found' }],
  ])('reads %s error bodies', (_name, body, expected) => {
    expect(upstreamDetail(body)).toEqual(expected);
  });

  it('keeps no code that is not a short identifier, and nothing from other bodies', () => {
    expect(upstreamDetail({ error: { code: 'has spaces in it', message: '' } })).toEqual({});
    expect(upstreamDetail('plain text')).toEqual({});
    expect(upstreamDetail(undefined)).toEqual({});
  });
});

describe('loggableMessage', () => {
  const sent = {
    model: 'some-model-name-that-is-long',
    messages: [{ role: 'user', content: 'Please keep my travel plans to Lisbon a secret.' }],
  };

  it('cuts the message to 200 characters and collapses whitespace', () => {
    const message = `Too\n many\t\ttokens. ${'x '.repeat(400)}`;
    const logged = loggableMessage(message, [], sent);
    expect(logged.startsWith('Too many tokens. x x')).toBe(true);
    expect(logged).toHaveLength(MAX_UPSTREAM_MESSAGE);
  });

  it('replaces the request key and anything shaped like a key', () => {
    const logged = loggableMessage(
      'Incorrect API key provided: test-key-not-secret. Also sk-proj-abcdefghijklmnop and ' +
        `Bearer abc.def and ${'a1'.repeat(20)}.`,
      ['test-key-not-secret'],
      sent,
    );
    expect(logged).toBe(
      'Incorrect API key provided: [redacted]. Also [redacted] and [redacted] and [redacted].',
    );
  });

  it("replaces every stretch that repeats the request's text, but not the model name", () => {
    const logged = loggableMessage(
      'Content blocked in "Please keep my travel plans to Lisbon a secret." for ' +
        'some-model-name-that-is-long',
      [],
      sent,
    );
    expect(logged).toBe('Content blocked in "[request text]" for some-model-name-that-is-long');
  });

  it('keeps a message that shares only short phrases with the prompt', () => {
    const prompt = { messages: [{ role: 'user', content: 'Why is the model overloaded today?' }] };
    expect(loggableMessage('Model is overloaded', [], prompt)).toBe('Model is overloaded');
  });
});
