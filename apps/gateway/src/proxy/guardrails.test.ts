import type { Redis } from '@ai-gateway/shared/node';
import { systemClock } from '@ai-gateway/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  sseData,
  testAdmission,
  testRouting,
} from '../../test/helpers.js';
import { buildApp } from '../app.js';
import { ResponseCache } from '../cache/response-cache.js';
import { verhoeffDigit } from '../guardrails/detectors.js';
import { guardrailPolicySchema, type GuardrailPolicyInput } from '../guardrails/policy.js';
import { parseModelsConfig } from '../models-config.js';
import type { ChatRequest, ChatResult, EmbeddingRequest, StreamEvent } from '../providers/types.js';
import { createRegistry } from '../providers/registry.js';
import { registerChatCompletions } from './chat-completions.js';
import { registerEmbeddings } from './embeddings.js';

// Guardrails through the /v1 handlers (M16, ADR 035): what the provider received, what the client
// got, and what the request's record holds.
function setup(policy: GuardrailPolicyInput, { cache = false } = {}) {
  const clock = systemClock;
  const { logger } = captureLogger();
  const models = parseModelsConfig(
    {
      deployments: {
        first: { provider: 'mock', mock: { completionTokens: 4 } },
        second: { provider: 'mock', mock: { completionTokens: 4 } },
        vectors: { provider: 'mock', type: 'embeddings', embedding: { dimensions: 4 } },
      },
      models: {
        'mock-one': { deployment: 'first' },
        'mock-pair': {
          policy: 'priority',
          targets: [{ deployment: 'first' }, { deployment: 'second' }],
        },
        'mock-vectors': { deployment: 'vectors' },
      },
    },
    'guardrails-test',
  );
  const registry = createRegistry(models, {
    clock,
    logger,
    env: {},
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const { verifier, authorization, record } = inMemoryVerifier(clock);
  record.guardrails = guardrailPolicySchema.parse(policy);
  const events = new RecordingBus();
  const admission = testAdmission(clock, logger);
  const routing = testRouting(registry, clock, { retry: { maxAttempts: 3 } });
  const stored = new Map<string, string>();
  const redis = {
    get: (k: string) => Promise.resolve(stored.get(k) ?? null),
    set: (k: string, v: string) => {
      stored.set(k, v);
      return Promise.resolve('OK');
    },
  } as unknown as Redis;
  const responseCache = cache
    ? new ResponseCache({ redis, logger, ttlSeconds: 60, maxEntryBytes: 100_000 })
    : null;
  const options = {
    registry,
    clock,
    verifier,
    events,
    admission,
    routing,
    cache: responseCache,
    guardrailsEnabled: true,
  };
  registerChatCompletions(app, options);
  registerEmbeddings(app, options);
  const provider = (id: string) => registry.deployment(id)!.provider;
  // Every request each provider received.
  const received: Record<string, ChatRequest[]> = { first: [], second: [] };
  for (const id of ['first', 'second'] as const) {
    const p = provider(id);
    const chat = p.chat.bind(p);
    vi.spyOn(p, 'chat').mockImplementation((req, signal) => {
      received[id]!.push(req);
      return chat(req, signal);
    });
    const chatStream = p.chatStream.bind(p);
    vi.spyOn(p, 'chatStream').mockImplementation((req, signal) => {
      received[id]!.push(req);
      return chatStream(req, signal);
    });
  }
  const post = (payload: object, url = '/v1/chat/completions') =>
    app.inject({ method: 'POST', url, headers: { authorization }, payload });
  return { app, post, received, events, provider, stored };
}

const say = (content: string, extra: object = {}) => ({
  model: 'mock-one',
  messages: [{ role: 'user', content }],
  ...extra,
});
/** Everything the provider was sent, as one string. */
const sentText = (requests: ChatRequest[]) => JSON.stringify(requests.map((r) => r.messages));

const aadhaarBase = '23456789012';
const AADHAAR = aadhaarBase + verhoeffDigit(aadhaarBase);
const BAD_AADHAAR = aadhaarBase + String((Number(verhoeffDigit(aadhaarBase)) + 1) % 10);
const VALUES = {
  email: { valid: 'jane.doe@example.com', invalid: 'jane.doe@localhost' },
  phone: { valid: '+91 98765 43210', invalid: '+91 58765 43210' },
  card: { valid: '4111 1111 1111 1111', invalid: '4111 1111 1111 1112' },
  aadhaar: { valid: AADHAAR, invalid: BAD_AADHAAR },
  pan: { valid: 'ABCPE1234F', invalid: 'ABCPE12345' },
} as const;
const PLACEHOLDERS = {
  email: '[EMAIL]',
  phone: '[PHONE]',
  card: '[CARD]',
  aadhaar: '[AADHAAR]',
  pan: '[PAN]',
} as const;

describe('guardrails before the model', () => {
  for (const type of Object.keys(VALUES) as (keyof typeof VALUES)[]) {
    it(`masks a valid ${type} before the provider sees it, and leaves an invalid one`, async () => {
      const { post, received, events } = setup({ input: { [type]: 'mask' } });
      const { valid, invalid } = VALUES[type];
      const res = await post(say(`Mine: ${valid}. Not mine: ${invalid}.`));
      expect(res.statusCode).toBe(200);
      const sent = sentText(received.first!);
      expect(sent).not.toContain(valid);
      expect(sent).toContain(PLACEHOLDERS[type]);
      expect(sent).toContain(invalid);
      expect(events.events.at(-1)!.guardrails).toEqual([
        { stage: 'input', check: type, count: 1, action: 'mask' },
      ]);
    });
  }

  it('blocks with a 400 that names the type, never the value, and calls no provider', async () => {
    const { post, received, events } = setup({ input: { card: 'block', email: 'flag' } });
    const res = await post(say('Charge 4111 1111 1111 1111 and mail jane@example.com'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: {
        code: 'guardrail_blocked',
        message:
          "The request contains a payment card number, which this project's guardrails do not allow.",
      },
    });
    expect(res.body).not.toContain('4111');
    expect(received.first).toHaveLength(0);
    const event = events.events.at(-1)!;
    expect(event.request).toMatchObject({ status: 'rejected', errorCode: 'guardrail_blocked' });
    expect(event.guardrails).toEqual(
      expect.arrayContaining([
        { stage: 'input', check: 'card', count: 1, action: 'block' },
        { stage: 'input', check: 'email', count: 1, action: 'flag' },
      ]),
    );
  });

  it('only records a flagged value: the provider gets it as sent', async () => {
    const { post, received, events } = setup({ input: { email: 'flag' } });
    expect((await post(say('mail jane@example.com'))).statusCode).toBe(200);
    expect(sentText(received.first!)).toContain('jane@example.com');
    expect(events.events.at(-1)!.guardrails).toEqual([
      { stage: 'input', check: 'email', count: 1, action: 'flag' },
    ]);
  });

  it('blocks or flags blocked words and phrases, as whole words', async () => {
    const blocking = setup({ blockedTerms: { terms: ['project titan'], action: 'block' } });
    const refused = (await blocking.post(say('Tell me about PROJECT  Titan'))).json<{
      error: { code: string; message: string };
    }>();
    expect(refused.error.code).toBe('guardrail_blocked');
    expect(refused.error.message).toContain('a blocked word or phrase');
    expect((await blocking.post(say('Tell me about project titanium'))).statusCode).toBe(200);
    const flagging = setup({ blockedTerms: { terms: ['titan'], action: 'flag' } });
    expect((await flagging.post(say('titan'))).statusCode).toBe(200);
    expect(flagging.events.events.at(-1)!.guardrails).toEqual([
      { stage: 'input', check: 'blocked_terms', count: 1, action: 'flag' },
    ]);
  });

  it('refuses a prompt over the cap with a 400', async () => {
    const { post, received } = setup({ maxPromptTokens: 20 });
    expect((await post(say('short'))).statusCode).toBe(200);
    const res = await post(say('word '.repeat(200)));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'guardrail_prompt_too_large' } });
    expect(received.first).toHaveLength(1);
  });

  it('masks embeddings input before the provider sees it', async () => {
    const { post, provider } = setup({ input: { email: 'mask' } });
    const p = provider('vectors');
    const seen: EmbeddingRequest[] = [];
    const embed = p.embed.bind(p);
    vi.spyOn(p, 'embed').mockImplementation((req, signal) => {
      seen.push(req);
      return embed(req, signal);
    });
    const res = await post(
      { model: 'mock-vectors', input: ['hi jane@example.com', 'b'] },
      '/v1/embeddings',
    );
    expect(res.statusCode).toBe(200);
    expect(seen[0]!.input).toEqual(['hi [EMAIL]', 'b']);
  });

  it('never caches an unmasked value, and keys the cache on the masked request', async () => {
    const { post, received, stored, provider } = setup(
      { input: { email: 'mask' } },
      { cache: true },
    );
    // The model repeats the prompt, as a model may.
    vi.spyOn(provider('first'), 'chat').mockImplementation((req) => {
      received.first!.push(req);
      const last = req.messages.at(-1)!;
      return Promise.resolve({
        content: `You said: ${typeof last.content === 'string' ? last.content : ''}`,
        finishReason: 'stop',
        usage: null,
      });
    });
    const first = await post(say('Echo jane@example.com', { temperature: 0 }));
    expect(first.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    const cached = [...stored.values()].join('');
    expect(cached).toContain('You said: Echo [EMAIL]');
    expect(cached).not.toContain('jane@example.com');
    // Another address masks to the same request: answered from the cache.
    const second = await post(say('Echo john@example.org', { temperature: 0 }));
    expect(second.headers['x-gateway-cache']).toBe('hit');
    expect(received.first).toHaveLength(1);
  });
});

describe('guardrails after the model', () => {
  const format = {
    type: 'json_schema',
    json_schema: {
      name: 'city',
      schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
  };
  const invalid = (): Promise<ChatResult> =>
    Promise.resolve({ content: '{"town":1}', finishReason: 'stop', usage: null });

  it('retries a schema failure once on the next deployment', async () => {
    const { post, received, provider, events } = setup({ output: { schema: 'retry' } });
    vi.spyOn(provider('first'), 'chat').mockImplementation((req) => {
      received.first!.push(req);
      return invalid();
    });
    const res = await post({ ...say('a city', { response_format: format }), model: 'mock-pair' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-deployment']).toBe('second');
    expect(
      JSON.parse(
        res.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content,
      ),
    ).toHaveProperty('city');
    expect(received.first).toHaveLength(1);
    expect(received.second).toHaveLength(1);
    expect(events.events.at(-1)!.guardrails).toEqual([
      { stage: 'output', check: 'schema', count: 1, action: 'retry' },
    ]);
  });

  it('answers 502 guardrail_output_failed when the retry fails too, also for a stream', async () => {
    const { post, provider } = setup({ output: { schema: 'retry' } });
    for (const id of ['first', 'second'])
      vi.spyOn(provider(id), 'chat').mockImplementation(invalid);
    const res = await post({ ...say('a city', { response_format: format }), model: 'mock-pair' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'guardrail_output_failed' } });
    // A streamed request is called without streaming, so it can still be refused before its
    // first byte.
    const streamed = await post({
      ...say('a city', { response_format: format, stream: true }),
      model: 'mock-pair',
    });
    expect(streamed.statusCode).toBe(502);
  });

  it('only records a schema failure under flag', async () => {
    const { post, provider, events } = setup({ output: { schema: 'flag' } });
    vi.spyOn(provider('first'), 'chat').mockImplementation(invalid);
    const res = await post(say('a city', { response_format: format }));
    expect(res.statusCode).toBe(200);
    expect(events.events.at(-1)!.guardrails).toEqual([
      { stage: 'output', check: 'schema', count: 1, action: 'flag' },
    ]);
  });

  it('masks a value split across two stream chunks', async () => {
    const { post, provider } = setup({ output: { email: 'mask' } });
    vi.spyOn(provider('first'), 'chatStream').mockImplementation(async function* () {
      const events: StreamEvent[] = [
        { type: 'content', text: 'Reach me at jane.d' },
        { type: 'content', text: 'oe@example.com today' },
        { type: 'finish', finishReason: 'stop', usage: null },
      ];
      for (const e of events) yield await Promise.resolve(e);
    });
    const res = await post(say('contact?', { stream: true }));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('jane.d');
    const text = sseData(res.body)
      .filter((d) => d !== '[DONE]')
      .map(
        (d) =>
          (JSON.parse(d) as { choices: { delta: { content?: string } }[] }).choices[0]?.delta
            .content ?? '',
      )
      .join('');
    expect(text).toBe('Reach me at [EMAIL] today');
  });

  it('masks answers that are not streamed', async () => {
    const { post, provider } = setup({ output: { phone: 'mask' } });
    vi.spyOn(provider('first'), 'chat').mockResolvedValue({
      content: 'Call 9876543210',
      finishReason: 'stop',
      usage: null,
    });
    const res = await post(say('number?'));
    expect(
      res.json<{ choices: { message: { content: string } }[] }>().choices[0]!.message.content,
    ).toBe('Call [PHONE]');
  });
});
