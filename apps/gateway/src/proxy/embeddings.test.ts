import { systemClock, usageEventSchema } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  testAdmission,
  testRouting,
} from '../../test/helpers.js';
import { BODY_LIMIT_BYTES, buildApp } from '../app.js';
import type { Limiter } from '../limits/limiter.js';
import { UNLIMITED, type UsagePolicy } from '../limits/policy.js';
import type { PriceRow } from '../limits/prices.js';
import { parseModelsConfig } from '../models-config.js';
import { ProviderError } from '../providers/errors.js';
import { mockVector, type MockProvider } from '../providers/mock.js';
import { createRegistry } from '../providers/registry.js';
import { registerChatCompletions } from './chat-completions.js';
import { base64Vector, registerEmbeddings } from './embeddings.js';

const models = parseModelsConfig(
  {
    deployments: {
      embed: {
        adapter: 'mock',
        type: 'embeddings',
        model: 'mock-embed',
        embedding: { dimensions: 16, dimensionsRange: { min: 2, max: 16 } },
      },
      fixed: { adapter: 'mock', type: 'embeddings', model: 'fixed', embedding: { dimensions: 8 } },
      wide: { adapter: 'mock', type: 'embeddings', model: 'wide', embedding: { dimensions: 4096 } },
      chat: { adapter: 'mock' },
    },
    models: {
      'mock-embed': { deployment: 'embed' },
      'fixed-embed': { deployment: 'fixed' },
      'wide-embed': { deployment: 'wide' },
      'mock-chat': { deployment: 'chat' },
    },
  },
  'embeddings-test',
);

interface Answer {
  object: string;
  data: { object: string; index: number; embedding: number[] | string }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

function setup({
  limiter,
  prices = [],
  policy = UNLIMITED,
}: {
  limiter?: Pick<Limiter, 'admit'>;
  prices?: PriceRow[];
  policy?: UsagePolicy;
} = {}) {
  // The mock's sleeps are 0 ms here, so a real clock keeps the test simple.
  const clock = systemClock;
  const { logger } = captureLogger();
  const registry = createRegistry(models, {
    clock,
    logger,
    env: {},
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const { verifier, authorization } = inMemoryVerifier(clock, policy);
  const events = new RecordingBus();
  const admission = testAdmission(clock, logger, { ...(limiter ? { limiter } : {}), prices });
  const routing = testRouting(registry, clock);
  registerChatCompletions(app, { registry, clock, verifier, events, admission, routing });
  registerEmbeddings(app, { registry, clock, verifier, events, admission, routing });
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { authorization }, payload: payload as object });
  const embed = (payload: unknown) => post('/v1/embeddings', payload);
  return { app, registry, events, embed, post };
}

const length = (v: number[]) => Math.sqrt(v.reduce((n, x) => n + x * x, 0));

describe('POST /v1/embeddings', () => {
  it("answers one input in OpenAI's format with a unit-length vector, and records it", async () => {
    const { embed, events } = setup();
    const res = await embed({ model: 'mock-embed', input: 'The quick brown fox' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Answer>();
    expect(body).toMatchObject({ object: 'list', model: 'mock-embed' });
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ object: 'embedding', index: 0 });
    const vector = body.data[0]!.embedding as number[];
    expect(vector).toHaveLength(16);
    expect(length(vector)).toBeCloseTo(1, 10);
    expect(vector).toEqual(mockVector('The quick brown fox', 16));
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens);
    expect(res.headers['x-gateway-deployment']).toBe('embed');

    const [event] = events.events;
    expect(usageEventSchema.safeParse(event).success).toBe(true);
    expect(event?.request).toMatchObject({
      endpoint: 'embeddings',
      model: 'mock-embed',
      deployment: 'embed',
      stream: false,
      status: 'success',
    });
    expect(event?.usage).toEqual({
      promptTokens: body.usage.prompt_tokens,
      completionTokens: 0,
      totalTokens: body.usage.prompt_tokens,
    });
    expect(event?.usageSource).toBe('reported');
    expect(event?.attempts).toHaveLength(1);
  });

  it('answers a batch in order, the same input always giving the same vector', async () => {
    const { embed } = setup();
    const res = await embed({ model: 'mock-embed', input: ['alpha', 'beta', 'alpha'] });
    const data = res.json<Answer>().data;
    expect(data.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(data[0]!.embedding).toEqual(data[2]!.embedding);
    expect(data[0]!.embedding).not.toEqual(data[1]!.embedding);
  });

  it('encodes base64 as little-endian float32, as OpenAI does', async () => {
    const { embed } = setup();
    const floats = await embed({ model: 'mock-embed', input: 'hi' });
    const encoded = await embed({ model: 'mock-embed', input: 'hi', encoding_format: 'base64' });
    const text = encoded.json<Answer>().data[0]!.embedding as string;
    expect(typeof text).toBe('string');
    const bytes = Buffer.from(text, 'base64');
    const decoded = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
    const expected = floats.json<Answer>().data[0]!.embedding as number[];
    expect(decoded).toHaveLength(16);
    decoded.forEach((x, i) => expect(x).toBeCloseTo(expected[i]!, 6));
    expect(base64Vector([1, -2])).toBe(
      Buffer.from([0, 0, 128, 63, 0, 0, 0, 192]).toString('base64'),
    );
  });

  it('takes dimensions only where the model allows them', async () => {
    const { embed } = setup();
    const small = await embed({ model: 'mock-embed', input: 'hi', dimensions: 4 });
    expect((small.json<Answer>().data[0]!.embedding as number[]).length).toBe(4);

    const fixed = await embed({ model: 'fixed-embed', input: 'hi', dimensions: 4 });
    expect(fixed.statusCode).toBe(400);
    expect(fixed.json()).toMatchObject({
      error: { code: 'unsupported_parameter', param: 'dimensions' },
    });
    expect(fixed.json<{ error: { message: string } }>().error.message).toMatch(/8/);

    const outside = await embed({ model: 'mock-embed', input: 'hi', dimensions: 32 });
    expect(outside.json()).toMatchObject({ error: { param: 'dimensions' } });
    expect(outside.json<{ error: { message: string } }>().error.message).toMatch(/from 2 to 16/);
  });

  it.each([
    ['token arrays', { model: 'mock-embed', input: [1, 2, 3] }, 'input', /token arrays/],
    ['nested token arrays', { model: 'mock-embed', input: [[1, 2]] }, 'input', /token arrays/],
    ['an empty string', { model: 'mock-embed', input: '' }, 'input', /Too small/],
    ['an empty list', { model: 'mock-embed', input: [] }, 'input', /Too small/],
    [
      'an unknown encoding',
      { model: 'mock-embed', input: 'x', encoding_format: 'int8' },
      'encoding_format',
      /encoding_format/,
    ],
    [
      'an unknown field',
      { model: 'mock-embed', input: 'x', truncate: true },
      'truncate',
      /Unrecognized/,
    ],
  ])('rejects %s with a 400', async (_name, payload, param, message) => {
    const { embed } = setup();
    const res = await embed(payload);
    expect(res.statusCode).toBe(400);
    const { error } = res.json<{ error: { param: string; message: string } }>();
    expect(error.param).toBe(param);
    expect(error.message).toMatch(message);
  });

  it('caps the inputs so the answer stays within what the gateway reads', async () => {
    const { embed, registry } = setup();
    // 393,216 numbers at 4,096 dimensions: 96 inputs.
    const res = await embed({ model: 'wide-embed', input: Array.from({ length: 97 }, () => 'x') });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'request_exceeds_limit', param: 'input' } });
    expect((registry.deployment('wide')?.provider as MockProvider).stats().requests).toBe(0);
  });

  it('caps the estimated input tokens per request', async () => {
    const { embed } = setup();
    // One token per "a" in the estimate, and still under the 1 MiB body limit.
    const res = await embed({ model: 'mock-embed', input: 'a '.repeat(300_001) });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/at most 300000/);
  });

  it('keeps the 1 MiB body limit that only chat completions raise (for images)', async () => {
    const { embed } = setup();
    const res = await embed({ model: 'mock-embed', input: 'a'.repeat(BODY_LIMIT_BYTES) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('sends each model to its own endpoint', async () => {
    const { embed, post } = setup();
    const chat = await embed({ model: 'mock-chat', input: 'x' });
    expect(chat.json()).toMatchObject({
      error: { code: 'model_endpoint_mismatch', param: 'model' },
    });
    const embeddings = await post('/v1/chat/completions', {
      model: 'mock-embed',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(embeddings.statusCode).toBe(400);
    expect(embeddings.json()).toMatchObject({ error: { code: 'model_endpoint_mismatch' } });
  });

  it('reserves the input tokens and their price only, with no output', async () => {
    const admitted: { tokens: number; costMicroUsd: number }[] = [];
    const limiter: Pick<Limiter, 'admit'> = {
      admit: (input) => {
        admitted.push({ tokens: input.tokens, costMicroUsd: input.costMicroUsd });
        return Promise.resolve({
          admitted: true,
          ticket: { keepAlive: () => undefined, settle: () => Promise.resolve() },
          rateLimits: {},
          budget: { spentMicroUsd: 0, reservedMicroUsd: 0 },
        } as never);
      },
    };
    const { embed, events } = setup({
      limiter,
      // $1 per million input tokens: easy to check.
      prices: [
        {
          id: '0192f000-0000-7000-8000-0000000000e1',
          provider: 'mock',
          model: 'mock-embed',
          inputMicroUsdPerMTok: 1_000_000,
          outputMicroUsdPerMTok: 0,
          effectiveFrom: 0,
        },
      ],
      policy: {
        ...UNLIMITED,
        key: { ...UNLIMITED.key, tpm: 1_000_000 },
        monthlyBudgetMicroUsd: 10_000_000,
      },
    });
    const res = await embed({ model: 'mock-embed', input: ['one two three', 'four five'] });
    expect(res.statusCode).toBe(200);
    const estimate = events.events[0]!.estimatedPromptTokens!;
    expect(admitted).toEqual([{ tokens: estimate, costMicroUsd: estimate }]);
  });

  it('fails a deployment that sends vectors of another size as an invalid response', async () => {
    const { embed, registry } = setup();
    const provider = registry.deployment('fixed')!.provider;
    provider.embed = () => Promise.resolve({ vectors: [[1, 0]], usage: null });
    const res = await embed({ model: 'fixed-embed', input: 'x' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'upstream_invalid_response' } });
  });

  it('estimates usage when the provider reports none', async () => {
    const { embed, registry, events } = setup();
    const provider = registry.deployment('fixed')!.provider;
    provider.embed = (req) =>
      Promise.resolve({ vectors: req.input.map(() => Array<number>(8).fill(0.5)), usage: null });
    const res = await embed({ model: 'fixed-embed', input: 'some words here' });
    expect(res.statusCode).toBe(200);
    const estimate = events.events[0]!.estimatedPromptTokens!;
    expect(res.json<Answer>().usage).toEqual({ prompt_tokens: estimate, total_tokens: estimate });
    expect(events.events[0]?.usageSource).toBe('estimated');
  });

  it('answers 502 after a provider failure, like chat', async () => {
    const { embed, registry } = setup();
    registry.deployment('fixed')!.provider.embed = () =>
      Promise.reject(new ProviderError('server_error', 'down', { upstreamStatus: 500 }));
    const res = await embed({ model: 'fixed-embed', input: 'x' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'upstream_error' } });
  });
});

describe('the mock embedding', () => {
  it('is deterministic and of unit length at any size', () => {
    for (const size of [1, 3, 256, 3072]) {
      const v = mockVector('hello', size);
      expect(v).toHaveLength(size);
      expect(length(v)).toBeCloseTo(1, 10);
      expect(mockVector('hello', size)).toEqual(v);
    }
    expect(mockVector('hello', 8)).not.toEqual(mockVector('hello!', 8));
  });

  it('fails as configured', async () => {
    const clock = systemClock;
    const { logger } = captureLogger();
    const registry = createRegistry(
      parseModelsConfig(
        {
          deployments: {
            down: {
              adapter: 'mock',
              type: 'embeddings',
              embedding: { dimensions: 4 },
              mock: { failWith: 500 },
            },
          },
          models: { down: { deployment: 'down' } },
        },
        't',
      ),
      { clock, logger, env: {}, ollamaBaseUrl: 'http://127.0.0.1:1' },
    );
    const provider = registry.deployment('down')!.provider;
    await expect(
      provider.embed({ model: 'mock', input: ['x'] }, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'server_error' });
  });
});
