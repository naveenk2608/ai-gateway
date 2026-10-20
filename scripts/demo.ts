/**
 * A two-minute demo against a running gateway: a rate limit rejecting requests, then a provider
 * failover with the routing history the gateway recorded for each request.
 *
 * Usage: pnpm demo   (after `pnpm db:seed` and `pnpm dev`, or the Compose `full` profile)
 *
 *   GATEWAY_URL     default http://127.0.0.1:8080
 *   ADMIN_EMAIL     default admin@example.com (what `pnpm db:seed` creates)
 *   ADMIN_PASSWORD  required: the password `pnpm db:seed` printed
 *
 * It creates two API keys for the demo and revokes them at the end.
 */

const base = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const email = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.ADMIN_PASSWORD;

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const say = (line = '') => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cookie = '';

async function admin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function chat(key: string, model: string) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hello' }] }),
  });
  const body = (await res.json()) as { error?: { code: string } };
  return {
    status: res.status,
    code: body.error?.code,
    retryAfter: res.headers.get('retry-after'),
    requestId: res.headers.get('x-request-id') ?? '',
  };
}

interface Attempt {
  attemptNumber: number;
  deployment: string;
  outcome: string;
  routingReason: string | null;
}

/** The request's attempts, once the worker has stored its usage event. */
async function routingHistory(requestId: string): Promise<Attempt[]> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/admin/requests/${requestId}`, { headers: { cookie } });
    if (res.status === 200) return ((await res.json()) as { attempts: Attempt[] }).attempts;
    await sleep(200);
  }
  throw new Error(`request ${requestId} was not recorded within 10 s; is the worker running?`);
}

async function main() {
  if (!password) {
    say('Set ADMIN_PASSWORD to the password `pnpm db:seed` printed (and ADMIN_EMAIL if not');
    say('admin@example.com), then run `pnpm demo` again.');
    process.exitCode = 1;
    return;
  }

  const login = await fetch(`${base}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (login.status !== 200)
    throw new Error(`login failed with ${login.status}: ${await login.text()}`);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const me = await admin<{ projects: { id: string; name: string; role: string }[] }>(
    'GET',
    '/admin/me',
  );
  const project = me.projects.find((p) => p.role === 'owner' || p.role === 'admin');
  if (!project) throw new Error(`${email} is not an admin of any project`);
  say(`${bold('AI Gateway demo')} against ${base}, project "${project.name}"`);

  const createKey = (name: string, limits?: object) =>
    admin<{ apiKey: { id: string }; key: string }>(
      'POST',
      `/admin/projects/${project.id}/api-keys`,
      { name, ...(limits ? { limits } : {}) },
    );
  const limited = await createKey('demo: 5 requests per minute', { requestsPerMinute: 5 });
  const open = await createKey('demo: no key limits');

  try {
    say();
    say(bold('1. Rate limit'));
    say(
      dim('A key limited to 5 requests per minute sends 8. The limit is a token bucket in Redis,'),
    );
    say(dim('so it holds across every gateway instance.'));
    for (let i = 1; i <= 8; i++) {
      const r = await chat(limited.key, 'mock-1');
      say(
        r.status === 200
          ? `  request ${i}: 200 OK`
          : `  request ${i}: ${r.status} ${r.code}, retry-after ${r.retryAfter ?? '?'} s`,
      );
    }

    say();
    say(bold('2. Provider failover'));
    say(dim('Model "mock-failover" routes to "mock-error" (always HTTP 500) first, then "mock".'));
    say(dim('Each request is retried once with backoff, then fails over; after 5 failures the'));
    say(dim("primary's circuit breaker opens and later requests skip it."));
    for (let i = 1; i <= 4; i++) {
      const r = await chat(open.key, 'mock-failover');
      say(`  request ${i}: ${r.status}${r.code ? ` ${r.code}` : ' OK'}  ${dim(r.requestId)}`);
      for (const a of await routingHistory(r.requestId)) {
        say(
          `    attempt ${a.attemptNumber}  ${a.deployment.padEnd(10)} ${a.outcome.padEnd(13)} ${dim(a.routingReason ?? '')}`,
        );
      }
    }
    say();
    say(`Open the dashboard (Requests tab) to see the same routing history.`);
  } finally {
    for (const key of [limited, open]) {
      await admin('POST', `/admin/projects/${project.id}/api-keys/${key.apiKey.id}/revoke`).catch(
        () => undefined,
      );
    }
    say(dim('Demo keys revoked.'));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
