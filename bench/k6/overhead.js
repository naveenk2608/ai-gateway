// Gateway overhead: the same requests sent to the mock directly (TARGET=direct) or through one
// gateway instance (TARGET=gateway), by VUS virtual users in a closed loop for DURATION.
//
//   -e TARGET=gateway|direct  -e STREAM=true|false  -e VUS=10  -e DURATION=20s
//
// TTFT is the time to the first response byte (k6 http_req_waiting): the gateway and the mock both
// send their headers with the first token. Throughput is completed requests over the time between
// the first request sent and the last answer received.
import http from 'k6/http';
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';
import {
  chatBody,
  completed,
  createKey,
  env,
  GATEWAYS,
  GATEWAY_MODEL,
  login,
  MAX_TOKENS,
  MOCK_URL,
  numberEnv,
  TREND_STATS,
  UPSTREAM_MODEL,
  writeSummary,
} from './lib.js';

const TARGET = env('TARGET', 'gateway');
const STREAM = env('STREAM', 'false') === 'true';
const VUS = numberEnv('VUS', 10);
const DURATION = env('DURATION', '20s');
// Above 0, so the cache never answers these requests.
const TEMPERATURE = 0.7;
if (TARGET !== 'gateway' && TARGET !== 'direct')
  throw new Error('TARGET must be gateway or direct');

export const options = {
  scenarios: { load: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  summaryTrendStats: TREND_STATS,
  // A run where 1% or more of the requests fail is not a measurement; k6 then exits non-zero.
  thresholds: { bench_error_rate: ['rate<0.01'] },
};

const latency = new Trend('bench_latency', true);
const ttft = new Trend('bench_ttft', true);
const done = new Counter('bench_completed');
const failed = new Counter('bench_failed');
const errorRate = new Rate('bench_error_rate');
const sentAt = new Gauge('bench_sent_at_ms');
const doneAt = new Gauge('bench_done_at_ms');

export function setup() {
  done.add(0);
  failed.add(0);
  if (TARGET === 'direct') return {};
  // Limits far above what the run reaches, so each request still pays for the Redis admission
  // check and release, as a key with limits does.
  const admin = login();
  const key = createKey(admin, `bench-overhead-${STREAM ? 'stream' : 'plain'}-${VUS}`, {
    requestsPerMinute: 1_000_000,
    tokensPerMinute: 1_000_000_000,
    concurrentRequests: 100_000,
  });
  return { authorization: `Bearer ${key.secret}` };
}

export default function (data) {
  const url = `${TARGET === 'gateway' ? GATEWAYS[0] : MOCK_URL}/v1/chat/completions`;
  const body = chatBody({
    model: TARGET === 'gateway' ? GATEWAY_MODEL : UPSTREAM_MODEL,
    prompt: 'Write a short reply for the benchmark.',
    stream: STREAM,
    temperature: TEMPERATURE,
  });
  const headers = { 'content-type': 'application/json' };
  if (data.authorization) headers.authorization = data.authorization;
  sentAt.add(Date.now());
  const res = http.post(url, body, { headers, tags: { kind: 'chat' } });
  doneAt.add(Date.now());
  const ok = completed(res, STREAM);
  errorRate.add(!ok);
  if (!ok) {
    failed.add(1);
    return;
  }
  done.add(1);
  latency.add(res.timings.duration);
  if (STREAM) ttft.add(res.timings.waiting);
}

export const handleSummary = writeSummary({
  scenario: 'overhead',
  target: TARGET,
  stream: STREAM,
  vus: VUS,
  duration: DURATION,
  maxTokens: MAX_TOKENS,
  temperature: TEMPERATURE,
});
