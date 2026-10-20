import { systemClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  sseData,
  testAdmission,
} from '../../test/helpers.js';
import { buildApp } from '../app.js';
import { parseModelsConfig } from '../models-config.js';
import type { MockProvider } from '../providers/mock.js';
import { createRegistry } from '../providers/registry.js';
import { registerChatCompletions } from '../proxy/chat-completions.js';
import { AdmissionControl } from './admission.js';
import type { Actual, Admission, AdmitRequest, Rejection, Ticket } from './limiter.js';
import { NO_SCOPE_LIMITS, UNLIMITED, type UsagePolicy } from './policy.js';
import { PriceBook } from './prices.js';

const models = parseModelsConfig(
  {
    deployments: {
      fast: {
        provider: 'mock',
        model: 'priced',
        maxOutputTokens: 100,
        mock: { completionTokens: 5 },
      },
    },
    models: { 'mock-fast': { deployment: 'fast' } },
  },
  'test',
);

/** $1 per million prompt tokens, $2 per million completion tokens: 1 and 2 micro-dollars each. */
const prices = [
  {
    id: '0192f000-0000-7000-8000-000000000001',
    provider: 'mock',
    model: 'priced',
    inputMicroUsdPerMTok: 1_000_000,
    outputMicroUsdPerMTok: 2_000_000,
    effectiveFrom: 0,
  },
];

const keyRpm: UsagePolicy = { ...UNLIMITED, key: { ...NO_SCOPE_LIMITS, rpm: 10 } };

interface SetupOptions {
  policy?: UsagePolicy;
  admit?: (request: AdmitRequest) => Promise<Admission>;
  failMode?: 'closed' | 'open';
  /** Prices could not be loaded yet (Postgres down at startup). */
  noPrices?: boolean;
}

function setup({ policy = keyRpm, admit, failMode = 'closed', noPrices }: SetupOptions = {}) {
  const { logger, lines } = captureLogger();
  const registry = createRegistry(models, {
    clock: systemClock,
    logger,
    env: {},
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
  const requests: AdmitRequest[] = [];
  const settled: Actual[] = [];
  const ticket = {
    keepAlive: () => undefined,
    settle: (actual: Actual) => {
      settled.push(actual);
      return Promise.resolve(true);
    },
  } as unknown as Ticket;
  const limiter = {
    admit: (request: AdmitRequest): Promise<Admission> => {
      requests.push(request);
      return admit ? admit(request) : Promise.resolve({ admitted: true, ticket });
    },
  };
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const { verifier, authorization } = inMemoryVerifier(systemClock, policy);
  const events = new RecordingBus();
  const admission = noPrices
    ? new AdmissionControl({
        limiter,
        prices: new PriceBook({
          load: () => Promise.reject(new Error('down')),
          clock: systemClock,
          logger,
          refreshMs: 60_000,
        }),
        failMode,
      })
    : testAdmission(systemClock, logger, { limiter, prices, failMode });
  registerChatCompletions(app, { registry, clock: systemClock, verifier, events, admission });
  const post = (body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization },
      payload: { model: 'mock-fast', messages: [{ role: 'user', content: 'Say hello' }], ...body },
    });
  const mock = registry.deployment('fast')?.provider as MockProvider;
  return { post, requests, settled, events, lines, mock };
}

const reject = (rejection: Rejection) => () =>
  Promise.resolve<Admission>({ admitted: false, rejection });

describe('admission before the provider call', () => {
  it('reserves the estimated prompt plus max_tokens', async () => {
    const t = setup();
    expect((await t.post({ max_tokens: 50 })).statusCode).toBe(200);
    // "Say hello": 2 words plus 6 framing tokens.
    expect(t.requests).toEqual([
      expect.objectContaining({ tokens: 8 + 50, costMicroUsd: 0, policy: keyRpm }),
    ]);
  });

  it("falls back to the deployment's maxOutputTokens and sends it upstream as the cap", async () => {
    const t = setup();
    await t.post({});
    expect(t.requests[0]?.tokens).toBe(8 + 100);
  });

  it('reserves the worst-case cost against a budget', async () => {
    const t = setup({ policy: { ...UNLIMITED, monthlyBudgetMicroUsd: 1_000 } });
    await t.post({ max_tokens: 50 });
    expect(t.requests[0]?.costMicroUsd).toBe(8 * 1 + 50 * 2);
  });

  it('settles to the usage the provider reported, once', async () => {
    const t = setup();
    await t.post({ max_tokens: 50 });
    // The mock reports 3 prompt tokens (its own estimate) and 5 completion tokens.
    expect(t.settled).toEqual([{ tokens: 8, costMicroUsd: 3 * 1 + 5 * 2 }]);
  });

  it('settles a stream when it ends', async () => {
    const t = setup();
    const res = await t.post({ stream: true });
    expect(sseData(res.body).at(-1)).toBe('[DONE]');
    expect(t.settled).toEqual([{ tokens: 8, costMicroUsd: 13 }]);
  });

  it('skips Redis entirely when nothing is limited', async () => {
    const t = setup({ policy: UNLIMITED });
    expect((await t.post({})).statusCode).toBe(200);
    expect(t.requests).toEqual([]);
  });
});

describe('rejections', () => {
  it('returns 429 with retry-after and the reason code, and never calls the provider', async () => {
    const t = setup({ admit: reject({ reason: 'rpm', scope: 'key', retryAfterMs: 1_500 }) });
    const res = await t.post({});
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.headers['x-should-retry']).toBe('true');
    expect(res.json()).toEqual({
      error: {
        message: 'Rate limit reached: 10 requests per minute for this API key.',
        type: 'rate_limit_error',
        param: null,
        code: 'rpm_limit_exceeded',
      },
    });
    expect(t.mock.stats().requests).toBe(0);
    expect(t.settled).toEqual([]);
  });

  it('emits a rejected event with the reason code', async () => {
    const t = setup({ admit: reject({ reason: 'tpm', scope: 'project', retryAfterMs: 100 }) });
    await t.post({});
    expect(t.events.events).toHaveLength(1);
    expect(t.events.events[0]?.request).toMatchObject({
      status: 'rejected',
      httpStatus: 429,
      errorCode: 'tpm_limit_exceeded',
    });
    expect(t.events.events[0]?.attempts).toEqual([]);
  });

  it('names the scope and limit of a concurrency rejection', async () => {
    const policy = { ...UNLIMITED, project: { ...NO_SCOPE_LIMITS, concurrency: 3 } };
    const t = setup({
      policy,
      admit: reject({ reason: 'concurrency', scope: 'project', retryAfterMs: 1_000 }),
    });
    const res = await t.post({});
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json<{ error: { message: string; code: string } }>().error).toMatchObject({
      code: 'concurrency_limit_exceeded',
      message: 'Too many requests in flight: this project allows 3 at once.',
    });
  });

  it('tells SDKs not to retry an exhausted budget, but says when it resets', async () => {
    const t = setup({
      policy: { ...UNLIMITED, monthlyBudgetMicroUsd: 100 },
      admit: reject({ reason: 'budget', scope: 'project', retryAfterMs: 86_400_000 }),
    });
    const res = await t.post({});
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('86400');
    expect(res.headers['x-should-retry']).toBe('false');
    expect(res.json<{ error: { code: string } }>().error.code).toBe('budget_exceeded');
  });

  it('answers 400 for a request that can never fit the limit', async () => {
    const policy = { ...UNLIMITED, key: { ...NO_SCOPE_LIMITS, tpm: 50 } };
    const t = setup({ policy, admit: reject({ reason: 'tpm', scope: 'key', retryAfterMs: null }) });
    const res = await t.post({});
    expect(res.statusCode).toBe(400);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.json<{ error: { code: string; param: string } }>().error).toMatchObject({
      code: 'request_exceeds_limit',
      param: 'max_tokens',
    });
  });

  it('rejects a request over the per-request cost cap without touching Redis', async () => {
    const t = setup({ policy: { ...UNLIMITED, maxRequestCostMicroUsd: 100 } });
    const res = await t.post({ max_tokens: 50 }); // worst case 108 micro-dollars
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('request_exceeds_limit');
    expect(t.requests).toEqual([]);
    expect((await t.post({ max_tokens: 40 })).statusCode).toBe(200); // 88
  });
});

describe('when Redis is unavailable (ADR 010)', () => {
  const down = () => Promise.reject(new Error('connect ECONNREFUSED'));

  it('rejects with 503 in closed mode', async () => {
    const t = setup({ admit: down, failMode: 'closed' });
    const res = await t.post({});
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json<{ error: { code: string } }>().error.code).toBe('limits_unavailable');
    expect(t.mock.stats().requests).toBe(0);
    expect(t.events.events[0]?.request).toMatchObject({
      status: 'rejected',
      errorCode: 'limits_unavailable',
    });
  });

  it('treats prices that could not be loaded yet like Redis being down', async () => {
    const budgeted = { ...UNLIMITED, monthlyBudgetMicroUsd: 1_000 };
    const closed = setup({ policy: budgeted, noPrices: true });
    expect((await closed.post({})).statusCode).toBe(503);
    expect(closed.requests).toEqual([]);
    const open = setup({ policy: budgeted, noPrices: true, failMode: 'open' });
    expect((await open.post({})).statusCode).toBe(200);
  });

  it('admits unchecked in open mode, and logs it', async () => {
    const t = setup({ admit: down, failMode: 'open' });
    expect((await t.post({})).statusCode).toBe(200);
    expect(t.lines.some((l) => l.msg?.includes('admitting without limits'))).toBe(true);
  });
});
