import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/**
 * A $0.02 monthly budget with a 50% soft threshold, end to end: gateway, worker, Redis and
 * Postgres. Each request writes 40 tokens; the priority route's first deployment costs $100 per
 * million output tokens ($0.004 a request), the second $50 ($0.002).
 */
const tag = randomBytes(4).toString('hex');
const expensiveModel = `exp-${tag}`;
const cheapModel = `cheap-${tag}`;
const BUDGET = 20_000; // $0.02 in micro-dollars

const models = parseModelsConfig(
  {
    deployments: {
      expensive: { adapter: 'mock', model: expensiveModel, mock: { completionTokens: 40 } },
      cheap: { adapter: 'mock', model: cheapModel, mock: { completionTokens: 40 } },
    },
    models: {
      'budget-demo': {
        policy: 'priority',
        targets: [{ deployment: 'expensive' }, { deployment: 'cheap' }],
      },
    },
  },
  'budget-test',
);

let gateway: Gateway;
let url: string;
let key: string;
let cookie: string;
let projectId: string;

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:budget:${tag}`,
      EVENTS_DLQ_STREAM: `test:budget:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `budget-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  const db = gateway.db;
  // Prices first: the gateway loads them when it starts, for budget reservations.
  await db
    .insertInto('model_prices')
    .values(
      [
        [expensiveModel, 100_000_000],
        [cheapModel, 50_000_000],
      ].map(([model, output]) => ({
        id: uuidv7(),
        provider: 'mock',
        model: model as string,
        input_micro_usd_per_mtok: 0,
        output_micro_usd_per_mtok: output as number,
        effective_from: new Date(Date.now() - 60_000),
      })),
    )
    .execute();
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;

  projectId = await createProject(db);
  await db
    .updateTable('projects')
    .set({ monthly_budget_micro_usd: BUDGET, budget_soft_threshold_pct: 50 })
    .where('id', '=', projectId)
    .execute();
  key = (await createApiKey(db, projectId)).plaintext;
  const user = await createUser(db, [{ projectId, role: 'viewer' }]);
  const res = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
});

afterAll(async () => {
  await gateway?.shutdown();
});

async function chat() {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'budget-demo',
      max_tokens: 40,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const body = (await res.json()) as { error?: { code: string } };
  return {
    status: res.status,
    code: body.error?.code,
    requestId: res.headers.get('x-request-id')!,
    deployment: res.headers.get('x-gateway-deployment'),
  };
}

async function routingReason(requestId: string): Promise<string | null> {
  let reason: string | null = null;
  await vi.waitFor(
    async () => {
      const res = await fetch(`${url}/admin/requests/${requestId}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { attempts: { routingReason: string | null }[] };
      reason = body.attempts.at(-1)?.routingReason ?? null;
    },
    { timeout: 10_000, interval: 100 },
  );
  return reason;
}

describe('a $0.02 budget with a soft threshold, end to end', () => {
  it('goes cheapest first above the threshold and refuses requests once the budget is spent', async () => {
    const served: { deployment: string | null; requestId: string }[] = [];
    let refused: Awaited<ReturnType<typeof chat>> | undefined;
    for (let i = 0; i < 15 && !refused; i++) {
      const result = await chat();
      if (result.status === 200) served.push(result);
      else refused = result;
    }

    // Below 50% the route's own order holds; from 50% on, the cheaper deployment answers.
    expect(served[0]?.deployment).toBe('expensive');
    const cheapest = served.filter((s) => s.deployment === 'cheap');
    expect(cheapest.length).toBeGreaterThan(0);
    expect(await routingReason(cheapest[0]!.requestId)).toMatch(
      /^budget at \d+%: cheapest first; cheapest: at most \d+ micro-USD/,
    );
    expect(await routingReason(served[0]!.requestId)).toBe('priority 1 of 2');

    // Then the budget is used up: a 429 the client should not retry this month.
    expect(refused).toMatchObject({ status: 429, code: 'budget_exceeded' });

    // What the worker recorded never passes the budget.
    await vi.waitFor(
      async () => {
        const period = await gateway.db
          .selectFrom('budget_periods')
          .select(['spent_micro_usd', 'limit_micro_usd'])
          .where('project_id', '=', projectId)
          .executeTakeFirstOrThrow();
        expect(period.limit_micro_usd).toBe(BUDGET);
        const expected = served.reduce(
          (sum, s) => sum + (s.deployment === 'expensive' ? 4_000 : 2_000),
          0,
        );
        expect(period.spent_micro_usd).toBe(expected);
        expect(period.spent_micro_usd).toBeLessThanOrEqual(BUDGET);
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});
