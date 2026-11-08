// Traffic spread under `peak_ewma` (M14, ADR 030): two mock deployments behind one logical model,
// one twice as slow as the other, then the faster one slowed down half way through. RATE requests
// per second for DURATION, alternating between both gateway instances (each keeps its own latency
// estimates). The deployment that served each request comes from `x-gateway-deployment`.
//
//   -e RATE=20  -e DURATION=60s  -e FAST_MS=100  -e SLOW_MS=200  -e SLOWED_MS=400
//
// setup() sets both mocks' timing through their POST /settings, so these values are the only
// source of the timings; at DURATION / 2 the `slowdown` scenario sets the fast mock to SLOWED_MS.
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import {
  chatBody,
  completed,
  createKey,
  env,
  GATEWAYS,
  login,
  numberEnv,
  seconds,
  TREND_STATS,
  writeSummary,
} from './lib.js';

const RATE = numberEnv('RATE', 20);
const DURATION = env('DURATION', '60s');
const FAST_MS = numberEnv('FAST_MS', 100);
const SLOW_MS = numberEnv('SLOW_MS', 200);
const SLOWED_MS = numberEnv('SLOWED_MS', 400);
const SLOW_AT_S = seconds(DURATION) / 2;
const MODEL = 'bench-spread';
const FAST_URL = env('MOCK_FAST_URL', 'http://mock-fast:8090');
const SLOW_URL = env('MOCK_SLOW_URL', 'http://mock-slow:8090');
const FAST = 'bench-fast';
const SLOW = 'bench-slow';

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
    slowdown: {
      executor: 'shared-iterations',
      exec: 'slowdown',
      vus: 1,
      iterations: 1,
      startTime: `${SLOW_AT_S}s`,
    },
  },
  summaryTrendStats: TREND_STATS,
  // The slowdown happened; otherwise k6 exits non-zero.
  thresholds: { spread_slowed: ['count==1'] },
};

const counters = {
  before: { [FAST]: new Counter('spread_before_fast'), [SLOW]: new Counter('spread_before_slow') },
  after: { [FAST]: new Counter('spread_after_fast'), [SLOW]: new Counter('spread_after_slow') },
};
const failed = new Counter('spread_failed');
const slowed = new Counter('spread_slowed');

function setTiming(url, ms) {
  const res = http.post(`${url}/settings`, JSON.stringify({ latencyMs: ms, ttftMs: ms }), {
    headers: { 'content-type': 'application/json' },
    tags: { kind: 'admin' },
  });
  if (res.status !== 200) throw new Error(`setting ${url} to ${ms} ms failed with ${res.status}`);
}

export function setup() {
  for (const phase of Object.values(counters)) for (const c of Object.values(phase)) c.add(0);
  failed.add(0);
  slowed.add(0);
  setTiming(FAST_URL, FAST_MS);
  setTiming(SLOW_URL, SLOW_MS);
  const admin = login();
  const key = createKey(admin, 'bench-spread', {
    requestsPerMinute: null,
    tokensPerMinute: null,
    concurrentRequests: null,
  });
  return { authorization: `Bearer ${key.secret}` };
}

export function load(data) {
  const n = exec.scenario.iterationInTest;
  // The phase is when the request was sent: before or after the fast mock was slowed down.
  const phase = exec.instance.currentTestRunDuration < SLOW_AT_S * 1000 ? 'before' : 'after';
  const res = http.post(
    `${GATEWAYS[n % GATEWAYS.length]}/v1/chat/completions`,
    // Sampled, so neither the cache nor coalescing answers.
    chatBody({ model: MODEL, prompt: `Spread check ${n}.`, stream: false, temperature: 0.7 }),
    {
      headers: { 'content-type': 'application/json', authorization: data.authorization },
      tags: { kind: 'chat' },
    },
  );
  const served = res.headers['X-Gateway-Deployment'];
  const counter = counters[phase][served];
  if (!completed(res, false) || !counter) failed.add(1);
  else counter.add(1);
}

export function slowdown() {
  setTiming(FAST_URL, SLOWED_MS);
  slowed.add(1);
}

export const handleSummary = writeSummary({
  scenario: 'spread',
  model: MODEL,
  policy: 'peak_ewma',
  rate: RATE,
  duration: DURATION,
  instances: GATEWAYS.length,
  fastMs: FAST_MS,
  slowMs: SLOW_MS,
  slowedMs: SLOWED_MS,
  slowAtS: SLOW_AT_S,
  temperature: 0.7,
});
