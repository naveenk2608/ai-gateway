import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestQueues,
  LOCALSTACK_REGION,
  LOCALSTACK_URL,
  localstackAvailable,
  type TestQueues,
} from '../../../test/localstack.js';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

// Against LocalStack (`docker compose --profile aws-local up -d`); skipped when it is not running.
const available = await localstackAvailable();

const models = parseModelsConfig(
  {
    deployments: { mock: { provider: 'mock', model: 'mock', mock: { completionTokens: 4 } } },
    models: { 'mock-1': { deployment: 'mock' } },
  },
  'sqs-pipeline-test',
);

let gateway: Gateway;
let queues: TestQueues;
let url: string;
let key: string;
let cookie: string;

describe.skipIf(!available)('usage pipeline over SQS (LocalStack)', () => {
  beforeAll(async () => {
    queues = await createTestQueues();
    gateway = createGateway(
      testConfig({
        EVENT_BUS: 'sqs',
        SQS_QUEUE_URL: queues.queueUrl,
        SQS_DLQ_URL: queues.dlqUrl,
        AWS_REGION: LOCALSTACK_REGION,
        SQS_ENDPOINT: LOCALSTACK_URL,
        RUN_WORKER_IN_PROCESS: 'true',
        WORKER_BLOCK_MS: '1000',
      }),
      captureLogger().logger,
      { models },
    );
    await gateway.start();
    url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
    const projectId = await createProject(gateway.db);
    key = (await createApiKey(gateway.db, projectId)).plaintext;
    const user = await createUser(gateway.db, [{ projectId, role: 'viewer' }]);
    const login = await fetch(`${url}/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  });

  afterAll(async () => {
    await gateway?.shutdown();
    await queues?.remove();
  });

  it('carries a request from /v1 through SQS to a stored record', async () => {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'mock-1', messages: [{ role: 'user', content: 'Say hello' }] }),
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id')!;

    await vi.waitFor(
      async () => {
        const detail = await fetch(`${url}/admin/requests/${requestId}`, { headers: { cookie } });
        expect(detail.status).toBe(200);
        expect(await detail.json()).toMatchObject({
          status: 'success',
          usage: { source: 'reported', totalTokens: 7 },
        });
      },
      { timeout: 15_000, interval: 200 },
    );
    expect(gateway.events.stats()).toMatchObject({ published: 1, dropped: 0 });
  });

  it('shows the queues on the infrastructure endpoint', async () => {
    const res = await fetch(`${url}/admin/analytics/infra?range=24h`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pipeline: unknown }).pipeline).toMatchObject({
      transport: 'sqs',
      consumers: null,
      oldestPendingAgeMs: null,
      deadLetterLength: 0,
    });
  });
});
