import { ManualClock } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import { describe, expect, it, vi } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { chatCompletionRequestSchema, type ChatCompletionRequest } from '../proxy/schema.js';
import {
  DEFAULT_SEMANTIC_THRESHOLD,
  parseSemanticPolicy,
  semanticPolicySchema,
  semanticRequested,
} from './policy.js';
import {
  SemanticCache,
  semanticContextKey,
  semanticText,
  vectorText,
  type EmbedCall,
  type Embedder,
} from './semantic-cache.js';

const body = (extra: Record<string, unknown> = {}): ChatCompletionRequest =>
  chatCompletionRequestSchema.parse({
    model: 'chat-a',
    temperature: 0,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Convert 10 km to miles.' },
    ],
    ...extra,
  });

const PROJECT = '0190b9a0-0000-7000-8000-000000000001';

describe('semanticText', () => {
  it("is the last user message's text", () => {
    expect(semanticText(body())).toBe('Convert 10 km to miles.');
    const parts = body({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    });
    expect(semanticText(parts)).toBe('a\nb');
  });

  it('is null for requests that make no lookup', () => {
    const image = body({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    const tools = body({
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    });
    const assistantLast = body({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    const blank = body({ messages: [{ role: 'user', content: '   ' }] });
    for (const b of [image, tools, assistantLast, blank]) expect(semanticText(b)).toBeNull();
  });
});

describe('semanticContextKey', () => {
  const key = (b: ChatCompletionRequest, project = PROJECT, embedder = 'embed-a') =>
    semanticContextKey(project, b, embedder);

  it('ignores the matched text and fields that do not change the answer', () => {
    const other = body({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'How many miles is ten kilometres?' },
      ],
    });
    expect(key(other)).toBe(key(body()));
    expect(key(body({ stream: true, user: 'someone' }))).toBe(key(body()));
  });

  it('changes with the project, model, embedding model, history and every parameter', () => {
    const base = key(body());
    const variants = [
      key(body(), '0190b9a0-0000-7000-8000-000000000002'),
      key(body(), PROJECT, 'embed-b'),
      key(body({ model: 'chat-b' })),
      key(body({ temperature: 0.5 })),
      key(body({ max_tokens: 10 })),
      key(body({ seed: 7 })),
      key(body({ stop: ['\n'] })),
      key(body({ response_format: { type: 'json_object' } })),
      key(
        body({
          messages: [
            { role: 'system', content: 'Be detailed.' },
            { role: 'user', content: 'Convert 10 km to miles.' },
          ],
        }),
      ),
      key(
        body({
          messages: [
            { role: 'system', content: 'Be brief.' },
            { role: 'user', name: 'other', content: 'Convert 10 km to miles.' },
          ],
        }),
      ),
    ];
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants).not.toContain(base);
  });
});

describe('semantic policy', () => {
  it('is off unless a project turns it on', () => {
    expect(parseSemanticPolicy({})).toEqual({
      mode: 'off',
      threshold: null,
      ttlSeconds: 3_600,
      maxEntries: 1_000,
    });
    expect(parseSemanticPolicy({ mode: 'everything' }).mode).toBe('off');
    expect(parseSemanticPolicy(null).mode).toBe('off');
    expect(semanticPolicySchema.safeParse({ threshold: 0.2 }).success).toBe(false);
    expect(semanticPolicySchema.safeParse({ ttlSeconds: 10 }).success).toBe(false);
    expect(semanticPolicySchema.safeParse({ maxEntries: 0 }).success).toBe(false);
  });

  it('follows the mode and the header', () => {
    const at = (mode: 'off' | 'header' | 'all', header?: string) =>
      semanticRequested(parseSemanticPolicy({ mode }), header);
    expect([at('off'), at('off', 'on')]).toEqual([false, false]);
    expect([at('header'), at('header', 'on'), at('header', ' ON '), at('header', 'off')]).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect([at('all'), at('all', 'on'), at('all', 'off')]).toEqual([true, true, false]);
  });
});

describe('vectorText', () => {
  it("is pgvector's text form", () => {
    expect(vectorText([0.5, -1, 2e-7])).toBe('[0.5,-1,2e-7]');
  });
});

/** The lookup's decisions, with the database parts replaced. */
class FakeCache extends SemanticCache {
  nearestResult: Awaited<ReturnType<SemanticCache['nearest']>> = null;
  nearestError: Error | null = null;
  readonly asked: unknown[][] = [];
  override available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  override nearest(...args: Parameters<SemanticCache['nearest']>) {
    this.asked.push(args);
    return this.nearestError
      ? Promise.reject(this.nearestError)
      : Promise.resolve(this.nearestResult);
  }
}

const embedding = {
  deployment: 'embed-a',
  provider: 'mock',
  providerModel: 'embed-a',
  billing: 'free_tier' as const,
  promptTokens: 6,
  usageSource: 'reported' as const,
};

function setup(embed: Embedder = () => Promise.resolve({ vector: [1, 0], record: embedding })) {
  const { logger } = captureLogger();
  const cache = new FakeCache({
    db: {} as Db,
    logger,
    clock: new ManualClock(1_000_000),
    embeddingModel: 'embed-a',
    embed,
  });
  const call: EmbedCall = {
    requestId: 'r1',
    projectId: PROJECT,
    apiKeyId: null,
    clientSignal: new AbortController().signal,
    log: logger,
  };
  return { cache, call };
}

const answer = {
  content: '6.21 miles',
  finishReason: 'stop' as const,
  usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
};

describe('SemanticCache.lookup', () => {
  const policy = (threshold: number | null) => parseSemanticPolicy({ mode: 'all', threshold });

  it('answers at or above the threshold, and misses below it', async () => {
    const { cache, call } = setup();
    const answeredBy = { provider: 'mock', providerModel: 'chat', billing: 'paid' as const };
    cache.nearestResult = { answer, similarity: 0.9, answeredBy };
    const hit = await cache.lookup({ body: body(), policy: policy(0.9), call });
    expect(hit?.hit).toEqual(answer);
    expect(hit?.record).toEqual({ outcome: 'hit', similarity: 0.9, embedding, answeredBy });
    expect(hit?.store).toBeNull();

    const miss = await cache.lookup({ body: body(), policy: policy(0.91), call });
    expect(miss?.hit).toBeNull();
    expect(miss?.record).toEqual({ outcome: 'miss', similarity: 0.9, embedding });
    expect(miss?.store).toBeTypeOf('function');
    // The project, the logical model and the context key are part of every query.
    expect(cache.asked[0]?.slice(0, 3)).toEqual([
      PROJECT,
      'chat-a',
      semanticContextKey(PROJECT, body(), 'embed-a'),
    ]);
  });

  it('uses the measured default when the project sets no threshold', async () => {
    const { cache, call } = setup();
    cache.nearestResult = {
      answer,
      similarity: DEFAULT_SEMANTIC_THRESHOLD - 0.001,
      answeredBy: null,
    };
    expect((await cache.lookup({ body: body(), policy: policy(null), call }))?.hit).toBeNull();
    cache.nearestResult = { answer, similarity: DEFAULT_SEMANTIC_THRESHOLD, answeredBy: null };
    expect((await cache.lookup({ body: body(), policy: policy(null), call }))?.hit).toEqual(answer);
  });

  it('a miss with nothing stored has no similarity, and no similarity is never a hit', async () => {
    const { cache, call } = setup();
    expect((await cache.lookup({ body: body(), policy: policy(0.5), call }))?.record).toEqual({
      outcome: 'miss',
      similarity: null,
      embedding,
    });
    cache.nearestResult = { answer, similarity: null, answeredBy: null };
    expect((await cache.lookup({ body: body(), policy: policy(0.5), call }))?.hit).toBeNull();
  });

  it('an embedding failure is an error without a call to pay for, and no store', async () => {
    const { cache, call } = setup(() => Promise.reject(new Error('upstream 500')));
    const found = await cache.lookup({ body: body(), policy: policy(0.9), call });
    expect(found).toEqual({
      record: { outcome: 'error', similarity: null, embedding: null },
      hit: null,
      store: null,
    });
    expect(cache.asked).toHaveLength(0);
  });

  it('a failed query is an error that still records the embedding call', async () => {
    const { cache, call } = setup();
    cache.nearestError = new Error('connection reset');
    const found = await cache.lookup({ body: body(), policy: policy(0.9), call });
    expect(found?.record).toEqual({ outcome: 'error', similarity: null, embedding });
    expect(found?.store).toBeNull();
  });

  it('makes no embedding call for a request it cannot match', async () => {
    const embed = vi.fn<Embedder>();
    const { cache, call } = setup(embed);
    const tools = body({ tools: [{ type: 'function', function: { name: 'f' } }] });
    expect(await cache.lookup({ body: tools, policy: policy(0.9), call })).toBeNull();
    expect(embed).not.toHaveBeenCalled();
  });
});
