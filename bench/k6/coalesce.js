// Request coalescing (M14, ADR 031): ROUNDS rounds of BATCH identical temperature-0 requests sent
// at once to one gateway instance (coalescing is per instance), every fifth one streamed, each
// round with a prompt of its own. The mock's own request counter, read before and after each
// round, shows how many calls reached the upstream; the gateway's `x-gateway-cache` header says
// how each request was answered (`miss`: it went upstream, `coalesced`: it waited for an
// identical request's call, `hit`: the cache answered).
//
//   -e ROUNDS=5  -e BATCH=50  -e UPSTREAM_MS=1000
//
// setup() sets the mock's latency to UPSTREAM_MS (POST /settings), so every request of a round
// arrives while the first one is upstream.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import {
  chatBody,
  completed,
  createKey,
  GATEWAYS,
  env,
  login,
  numberEnv,
  TREND_STATS,
  writeSummary,
} from './lib.js';

const ROUNDS = numberEnv('ROUNDS', 5);
const BATCH = numberEnv('BATCH', 50);
const UPSTREAM_MS = numberEnv('UPSTREAM_MS', 1000);
const MODEL = 'bench-coalesce';
const MOCK = env('MOCK_SLOW_URL', 'http://mock-slow:8090');

export const options = {
  scenarios: {
    rounds: {
      executor: 'shared-iterations',
      exec: 'round',
      vus: 1,
      iterations: ROUNDS,
      maxDuration: '5m',
    },
  },
  // Every request of a batch in flight at once.
  batch: BATCH,
  batchPerHost: BATCH,
  summaryTrendStats: TREND_STATS,
  thresholds: { co_rounds: [`count==${ROUNDS}`] },
};

const sent = new Counter('co_sent');
const coalesced = new Counter('co_coalesced');
const hits = new Counter('co_hits');
const misses = new Counter('co_misses');
const failed = new Counter('co_failed');
const upstream = new Counter('co_upstream_requests');
/** Rounds in which exactly one call reached the mock. */
const single = new Counter('co_rounds_one_call');
const rounds = new Counter('co_rounds');

function mockRequests() {
  const res = http.get(`${MOCK}/stats`, { tags: { kind: 'admin' } });
  if (res.status !== 200) throw new Error(`mock stats failed with ${res.status}`);
  return res.json('requests');
}

export function setup() {
  for (const c of [sent, coalesced, hits, misses, failed, upstream, single, rounds]) c.add(0);
  const res = http.post(
    `${MOCK}/settings`,
    JSON.stringify({ latencyMs: UPSTREAM_MS, ttftMs: UPSTREAM_MS }),
    { headers: { 'content-type': 'application/json' }, tags: { kind: 'admin' } },
  );
  if (res.status !== 200) throw new Error(`setting the mock's latency failed with ${res.status}`);
  const admin = login();
  const key = createKey(admin, 'bench-coalesce', {
    requestsPerMinute: null,
    tokensPerMinute: null,
    concurrentRequests: null,
  });
  return { authorization: `Bearer ${key.secret}`, tag: String(Date.now()) };
}

export function round(data) {
  const n = exec.scenario.iterationInTest;
  const before = mockRequests();
  const prompt = `Coalescing check ${data.tag}, round ${n}.`;
  const streamed = Array.from({ length: BATCH }, (_, i) => i % 5 === 4);
  const responses = http.batch(
    streamed.map((stream) => ({
      method: 'POST',
      url: `${GATEWAYS[0]}/v1/chat/completions`,
      body: chatBody({ model: MODEL, prompt, stream, temperature: 0 }),
      params: {
        headers: { 'content-type': 'application/json', authorization: data.authorization },
        tags: { kind: 'chat' },
      },
    })),
  );
  responses.forEach((res, i) => {
    sent.add(1);
    const cache = res.headers['X-Gateway-Cache'];
    if (!completed(res, streamed[i])) failed.add(1);
    else if (cache === 'coalesced') coalesced.add(1);
    else if (cache === 'hit') hits.add(1);
    else if (cache === 'miss') misses.add(1);
    else failed.add(1);
  });
  const calls = mockRequests() - before;
  upstream.add(calls);
  if (calls === 1) single.add(1);
  rounds.add(1);
}

export const handleSummary = writeSummary({
  scenario: 'coalesce',
  model: MODEL,
  rounds: ROUNDS,
  batch: BATCH,
  upstreamMs: UPSTREAM_MS,
  instance: GATEWAYS[0],
  streamedShare: 0.2,
  temperature: 0,
});
