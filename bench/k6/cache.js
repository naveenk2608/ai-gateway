// Cache hit ratio for a repeated temperature-0 workload: PROMPTS distinct prompts, repeated at
// RATE requests per second for DURATION across both gateway instances (they share one Redis
// cache, ADR 013).
//
//   -e PROMPTS=20  -e RATE=20  -e DURATION=20s
//
// The best possible ratio misses each prompt once: 1 - PROMPTS / requests. Hits and misses come
// from the gateway's `x-gateway-cache` header; the `verify` scenario reads the mock's request
// counter, so calls that reached the upstream are counted on the upstream's side too.
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import {
  chatBody,
  completed,
  createKey,
  env,
  GATEWAYS,
  GATEWAY_MODEL,
  login,
  MOCK_URL,
  numberEnv,
  seconds,
  TREND_STATS,
  writeSummary,
} from './lib.js';

const PROMPTS = numberEnv('PROMPTS', 20);
const RATE = numberEnv('RATE', 20);
const DURATION = env('DURATION', '20s');

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
      startTime: `${seconds(DURATION) + 3}s`,
    },
  },
  summaryTrendStats: TREND_STATS,
  // The verify step ran to the end; otherwise k6 exits non-zero.
  thresholds: { cache_verified: ['count==1'] },
};

const sent = new Counter('cache_sent');
const hits = new Counter('cache_hits');
const misses = new Counter('cache_misses');
const failed = new Counter('cache_failed');
const upstream = new Counter('cache_upstream_requests');
const verified = new Counter('cache_verified');

function mockRequests() {
  const res = http.get(`${MOCK_URL}/stats`, { tags: { kind: 'admin' } });
  if (res.status !== 200) throw new Error(`mock stats failed with ${res.status}`);
  return res.json('requests');
}

export function setup() {
  for (const counter of [sent, hits, misses, failed, upstream]) counter.add(0);
  const admin = login();
  const key = createKey(admin, 'bench-cache', {
    requestsPerMinute: null,
    tokensPerMinute: null,
    concurrentRequests: null,
  });
  return { authorization: `Bearer ${key.secret}`, mockRequestsBefore: mockRequests() };
}

export function load(data) {
  const n = exec.scenario.iterationInTest;
  sent.add(1);
  const res = http.post(
    `${GATEWAYS[n % GATEWAYS.length]}/v1/chat/completions`,
    chatBody({
      model: GATEWAY_MODEL,
      prompt: `Cache check, prompt ${n % PROMPTS}.`,
      stream: false,
      temperature: 0,
    }),
    {
      headers: { 'content-type': 'application/json', authorization: data.authorization },
      tags: { kind: 'chat' },
    },
  );
  const cache = res.headers['X-Gateway-Cache'];
  if (!completed(res, false) || (cache !== 'hit' && cache !== 'miss')) failed.add(1);
  else if (cache === 'hit') hits.add(1);
  else misses.add(1);
}

export function verify(data) {
  upstream.add(mockRequests() - data.mockRequestsBefore);
  verified.add(1);
}

export const handleSummary = writeSummary({
  scenario: 'cache',
  prompts: PROMPTS,
  rate: RATE,
  duration: DURATION,
  instances: GATEWAYS.length,
  temperature: 0,
});
