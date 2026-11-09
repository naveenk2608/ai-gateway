import type { AddressInfo } from 'node:net';
import { ManualClock } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { BreakerAlerts } from '../src/routing/breaker-alerts.js';
import { createProject, createUser } from './db-fixtures.js';
import { captureLogger, noModels, testConfig } from './helpers.js';

// Webhook alerts (M15, ADR 033): the admin API that manages destinations, and breaker alerts.
let gateway: Gateway;
let url: string;

beforeAll(async () => {
  // The in-process worker stays off: these tests look at what is queued, not at sending.
  gateway = createGateway(testConfig(), captureLogger().logger, { models: noModels });
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.shutdown();
});

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, text };
}

async function adminOf(projectId: string): Promise<string> {
  const user = await createUser(gateway.db, [{ projectId, role: 'admin' }]);
  const res = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

describe('alert destinations', () => {
  it('stores the URL encrypted, shows it masked, and returns a generic secret only once', async () => {
    const projectId = await createProject(gateway.db);
    const cookie = await adminOf(projectId);
    const hookUrl = 'https://hooks.example.com/services/T000/B000/secret-token-1234';
    const created = await api<{
      destination: { id: string; urlHint: string; kind: string };
      secret: string | null;
    }>('POST', `/admin/projects/${projectId}/alerts/destinations`, cookie, {
      name: 'ops',
      kind: 'generic',
      url: hookUrl,
      events: ['budget', 'breaker'],
    });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.destination.urlHint).toBe('https://hooks.example.com/…1234');
    expect(created.text).not.toContain('secret-token');

    const listed = await api<{ destinations: unknown[]; enabled: boolean }>(
      'GET',
      `/admin/projects/${projectId}/alerts`,
      cookie,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.enabled).toBe(true);
    expect(listed.body.destinations).toHaveLength(1);
    expect(listed.text).not.toContain('secret-token');
    expect(listed.text).not.toContain(created.body.secret!);

    const row = await gateway.db
      .selectFrom('alert_destinations')
      .selectAll()
      .where('id', '=', created.body.destination.id)
      .executeTakeFirstOrThrow();
    expect(row.url_ciphertext.toString('latin1')).not.toContain('hooks.example.com');
    expect(row.secret_ciphertext).not.toBeNull();
    // The audit row names the destination, never its URL.
    const audit = await gateway.db
      .selectFrom('audit_logs')
      .select('details')
      .where('target_id', '=', created.body.destination.id)
      .execute();
    expect(JSON.stringify(audit)).not.toContain('hooks.example.com');
  });

  it('refuses a URL that is not https, and a name used twice', async () => {
    const projectId = await createProject(gateway.db);
    const cookie = await adminOf(projectId);
    const path = `/admin/projects/${projectId}/alerts/destinations`;
    const plain = await api('POST', path, cookie, {
      name: 'plain',
      kind: 'slack',
      url: 'http://hooks.example.com/x',
      events: ['budget'],
    });
    expect(plain.status).toBe(400);
    const body = {
      name: 'twice',
      kind: 'discord',
      url: 'https://example.com/a',
      events: ['breaker'],
    };
    expect((await api('POST', path, cookie, body)).status).toBe(201);
    expect((await api('POST', path, cookie, body)).status).toBe(409);
  });

  it('queues a test delivery, shown in the recent deliveries', async () => {
    const projectId = await createProject(gateway.db);
    const cookie = await adminOf(projectId);
    const created = await api<{ destination: { id: string } }>(
      'POST',
      `/admin/projects/${projectId}/alerts/destinations`,
      cookie,
      { name: 'chat', kind: 'slack', url: 'https://hooks.example.com/x', events: ['budget'] },
    );
    const id = created.body.destination.id;
    const test = await api<{ deliveryId: string }>(
      'POST',
      `/admin/projects/${projectId}/alerts/destinations/${id}/test`,
      cookie,
    );
    expect(test.status).toBe(202);
    const listed = await api<{ deliveries: { id: string; eventType: string; status: string }[] }>(
      'GET',
      `/admin/projects/${projectId}/alerts`,
      cookie,
    );
    expect(listed.body.deliveries).toEqual([
      expect.objectContaining({ id: test.body.deliveryId, eventType: 'test', status: 'pending' }),
    ]);
  });
});

describe('BreakerAlerts', () => {
  it('queues a breaker alert at most once per deployment and interval, for every destination that chose it', async () => {
    const a = await createProject(gateway.db);
    const b = await createProject(gateway.db);
    const cookieA = await adminOf(a);
    const cookieB = await adminOf(b);
    const add = async (projectId: string, cookie: string, events: string[]) =>
      (
        await api<{ destination: { id: string } }>(
          'POST',
          `/admin/projects/${projectId}/alerts/destinations`,
          cookie,
          {
            name: `d-${events.join('-')}`,
            kind: 'slack',
            url: 'https://hooks.example.com/x',
            events,
          },
        )
      ).body.destination.id;
    const inA = await add(a, cookieA, ['breaker']);
    const inB = await add(b, cookieB, ['breaker', 'budget']);
    const budgetOnly = await add(a, cookieA, ['budget']);

    const clock = new ManualClock(Date.UTC(2032, 0, 1) + Math.floor(Math.random() * 1e9));
    const alerts = new BreakerAlerts({
      db: gateway.db,
      clock,
      logger: captureLogger().logger,
      intervalMs: 900_000,
      enabled: true,
      provider: () => 'mock',
    });
    const deployment = `dep-${Math.random().toString(16).slice(2, 8)}`;
    await alerts.opened(deployment);
    await alerts.opened(deployment);
    await clock.advance(60_000);
    await alerts.opened(deployment);
    const count = async (destinationId: string) =>
      (
        await gateway.db
          .selectFrom('alert_deliveries')
          .select('event_type')
          .where('destination_id', '=', destinationId)
          .where('event_type', '=', 'breaker.opened')
          .execute()
      ).length;
    expect([await count(inA), await count(inB), await count(budgetOnly)]).toEqual([1, 1, 0]);
    await clock.advance(900_000);
    await alerts.opened(deployment);
    expect([await count(inA), await count(inB)]).toEqual([2, 2]);
  });
});
