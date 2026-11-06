import { systemClock } from '@ai-gateway/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { sendJson, startFakeUpstream, type FakeUpstream } from '../../test/fake-upstream.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { Provider } from './types.js';

let upstream: FakeUpstream | undefined;
let provider: Provider | undefined;

afterEach(async () => {
  await provider?.close();
  await upstream?.close();
  provider = undefined;
  upstream = undefined;
});

const signal = () => new AbortController().signal;

describe('OpenAI-compatible embeddings', () => {
  it('posts to /embeddings asking for floats, and puts the vectors in input order', async () => {
    upstream = await startFakeUpstream((_req, res) =>
      sendJson(
        res,
        200,
        {
          object: 'list',
          // Out of order on purpose: the index says where each belongs.
          data: [
            { object: 'embedding', index: 1, embedding: [0, 1] },
            { object: 'embedding', index: 0, embedding: [1, 0] },
          ],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        },
        { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '99' },
      ),
    );
    provider = new OpenAICompatibleProvider({
      baseUrl: `${upstream.url}/v1`,
      apiKey: 'test-key-not-secret',
      clock: systemClock,
    });
    const result = await provider.embed({ model: 'e', input: ['a', 'b'] }, signal());
    expect(result).toEqual({
      vectors: [
        [1, 0],
        [0, 1],
      ],
      usage: { promptTokens: 7, completionTokens: 0, totalTokens: 7 },
      rateLimit: { limitRequests: 100, remainingRequests: 99 },
    });
    const sent = upstream.requests[0]!;
    expect(sent.url).toBe('/v1/embeddings');
    expect(sent.headers.authorization).toBe('Bearer test-key-not-secret');
    expect(JSON.parse(sent.body)).toEqual({
      model: 'e',
      input: ['a', 'b'],
      encoding_format: 'float',
    });
  });

  it('sends dimensions when asked, and reads an answer without usage', async () => {
    upstream = await startFakeUpstream((_req, res) =>
      sendJson(res, 200, { data: [{ embedding: [0.5, 0.5] }] }),
    );
    provider = new OpenAICompatibleProvider({
      baseUrl: upstream.url,
      apiKey: 'test-key-not-secret',
      clock: systemClock,
    });
    const result = await provider.embed({ model: 'e', input: ['a'], dimensions: 2 }, signal());
    expect(result.usage).toBeNull();
    expect(JSON.parse(upstream.requests[0]!.body)).toMatchObject({ dimensions: 2 });
  });

  it('rejects an answer that is not a list of vectors', async () => {
    upstream = await startFakeUpstream((_req, res) => sendJson(res, 200, { data: 'nope' }));
    provider = new OpenAICompatibleProvider({
      baseUrl: upstream.url,
      apiKey: 'test-key-not-secret',
      clock: systemClock,
    });
    await expect(provider.embed({ model: 'e', input: ['a'] }, signal())).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('maps an upstream 429 to rate_limited', async () => {
    upstream = await startFakeUpstream((_req, res) =>
      sendJson(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '3' }),
    );
    provider = new OpenAICompatibleProvider({
      baseUrl: upstream.url,
      apiKey: 'test-key-not-secret',
      clock: systemClock,
    });
    await expect(provider.embed({ model: 'e', input: ['a'] }, signal())).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 3_000,
    });
  });
});

describe('Ollama embeddings', () => {
  it('posts to /api/embed and reads the vectors and the input tokens', async () => {
    upstream = await startFakeUpstream((_req, res) =>
      sendJson(res, 200, {
        model: 'nomic-embed-text',
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
        prompt_eval_count: 9,
      }),
    );
    provider = new OllamaProvider({ baseUrl: upstream.url, clock: systemClock });
    const result = await provider.embed({ model: 'nomic-embed-text', input: ['a', 'b'] }, signal());
    expect(result).toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { promptTokens: 9, completionTokens: 0, totalTokens: 9 },
    });
    expect(upstream.requests[0]!.url).toBe('/api/embed');
    expect(JSON.parse(upstream.requests[0]!.body)).toEqual({
      model: 'nomic-embed-text',
      input: ['a', 'b'],
    });
  });

  it("turns Ollama's error object into server_error", async () => {
    upstream = await startFakeUpstream((_req, res) => sendJson(res, 200, { error: 'model gone' }));
    provider = new OllamaProvider({ baseUrl: upstream.url, clock: systemClock });
    await expect(provider.embed({ model: 'x', input: ['a'] }, signal())).rejects.toMatchObject({
      kind: 'server_error',
    });
  });
});
