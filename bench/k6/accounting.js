// Usage accounting under load and a worker crash: requests sent through both gateway instances
// must each be stored exactly once (ADR 014), counted the same in raw records and in rollups.
//
//   -e RATE=40  -e DURATION=30s
//
// `pnpm bench` injects the fault while this runs: it pauses Postgres so the worker's batch stalls
// mid-insert, kills the worker with SIGKILL, then unpauses Postgres and starts the worker again,
// which claims the unacknowledged events and stores them. After the load, the `verify` scenario
// waits until the stream has no unread or pending events and counts what was stored for the key.
import { sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Gauge } from 'k6/metrics';
import {
  adminGet,
  chatBody,
  completed,
  createKey,
  env,
  GATEWAYS,
  GATEWAY_MODEL,
  login,
  numberEnv,
  seconds,
  TREND_STATS,
  writeSummary,
} from './lib.js';

const RATE = numberEnv('RATE', 40);
const DURATION = env('DURATION', '30s');
const WORKER_METRICS_URL = env('WORKER_METRICS_URL', 'http://worker:9465/metrics');
const DRAIN_TIMEOUT_MS = 120_000;

export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      exec: 'load',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: RATE,
      maxVUs: RATE * 3,
    },
    verify: {
      executor: 'shared-iterations',
      exec: 'verify',
      vus: 1,
      iterations: 1,
      startTime: `${seconds(DURATION) + 5}s`,
      maxDuration: `${DRAIN_TIMEOUT_MS / 1000 + 60}s`,
    },
  },
  summaryTrendStats: TREND_STATS,
  // The verify step ran to the end; otherwise k6 exits non-zero.
  thresholds: { acct_verified: ['count==1'] },
};

const sent = new Counter('acct_sent');
const answered = new Counter('acct_completed');
const failed = new Counter('acct_failed');
const rows = new Counter('acct_rows_stored');
const distinct = new Counter('acct_distinct_requests');
const rollup = new Counter('acct_rollup_requests');
const deadLetters = new Counter('acct_dead_letters');
const reclaimed = new Counter('acct_worker_reclaimed');
const drainWait = new Gauge('acct_drain_wait_ms');
const verified = new Counter('acct_verified');

export function setup() {
  for (const counter of [sent, answered, failed, rows, distinct, rollup, deadLetters, reclaimed]) {
    counter.add(0);
  }
  const admin = login();
  const key = createKey(admin, 'bench-accounting', {
    requestsPerMinute: null,
    tokensPerMinute: null,
    concurrentRequests: null,
  });
  return { admin, apiKeyId: key.id, authorization: `Bearer ${key.secret}` };
}

export function load(data) {
  const n = exec.scenario.iterationInTest;
  // Both instances, streaming and not, in every combination.
  const stream = Math.floor(n / GATEWAYS.length) % 2 === 1;
  sent.add(1);
  const res = http.post(
    `${GATEWAYS[n % GATEWAYS.length]}/v1/chat/completions`,
    chatBody({ model: GATEWAY_MODEL, prompt: `Accounting check ${n}.`, stream, temperature: 0.7 }),
    {
      headers: { 'content-type': 'application/json', authorization: data.authorization },
      tags: { kind: 'chat' },
    },
  );
  if (completed(res, stream)) answered.add(1);
  else failed.add(1);
}

export function verify(data) {
  const started = Date.now();
  // Drained: no unread and no pending events, three readings in a row.
  let quiet = 0;
  let pipeline = null;
  while (quiet < 3) {
    if (Date.now() - started > DRAIN_TIMEOUT_MS) throw new Error('the usage stream did not drain');
    pipeline = adminGet(data.admin, '/admin/analytics/infra?range=1h').pipeline;
    const drained = pipeline && pipeline.unreadEvents === 0 && pipeline.pendingEvents === 0;
    quiet = drained ? quiet + 1 : 0;
    if (quiet < 3) sleep(1);
  }
  drainWait.add(Date.now() - started);
  deadLetters.add(pipeline.deadLetterLength);

  const ids = new Set();
  let stored = 0;
  let cursor = null;
  do {
    const page = adminGet(
      data.admin,
      `/admin/analytics/requests?range=1h&apiKeyId=${data.apiKeyId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    for (const request of page.data) ids.add(request.id);
    stored += page.data.length;
    cursor = page.nextCursor;
  } while (cursor);
  rows.add(stored);
  distinct.add(ids.size);

  const overview = adminGet(
    data.admin,
    `/admin/analytics/overview?range=1h&apiKeyId=${data.apiKeyId}`,
  );
  rollup.add(overview.totals.requests);

  // The restarted worker's counter: events it claimed from the killed one.
  const metrics = http.get(WORKER_METRICS_URL, { tags: { kind: 'admin' } });
  const match = /^worker_events_reclaimed_total (\S+)$/m.exec(String(metrics.body));
  if (metrics.status !== 200 || !match) throw new Error('worker metrics unavailable');
  reclaimed.add(Number(match[1]));
  verified.add(1);
}

export const handleSummary = writeSummary({
  scenario: 'accounting',
  rate: RATE,
  duration: DURATION,
  instances: GATEWAYS.length,
  streamingShare: 0.5,
  fault: {
    postgresPausedAtS: numberEnv('FAULT_PAUSE_AT_S', 0),
    workerKilledAtS: numberEnv('FAULT_KILL_AT_S', 0),
    postgresUnpausedAtS: numberEnv('FAULT_UNPAUSE_AT_S', 0),
    workerStartedAtS: numberEnv('FAULT_START_AT_S', 0),
  },
});
