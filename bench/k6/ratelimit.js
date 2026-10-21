// Rate-limit accuracy across two gateway instances: one key with RPM requests per minute, sent
// RATE requests per second for DURATION, alternating between the instances.
//
//   -e RPM=60  -e RATE=10  -e DURATION=30s
//
// The RPM bucket (ADR 008) starts full and refills RPM tokens per minute, shared by both
// instances through Redis. So between the first and the last request it can admit at most
// RPM + RPM x window / 60; the report compares the admitted count with that ceiling.
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Gauge } from 'k6/metrics';
import {
  chatBody,
  createKey,
  env,
  GATEWAYS,
  GATEWAY_MODEL,
  login,
  numberEnv,
  TREND_STATS,
  writeSummary,
} from './lib.js';

const RPM = numberEnv('RPM', 60);
const RATE = numberEnv('RATE', 10);
const DURATION = env('DURATION', '30s');

export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: RATE * 2,
      maxVUs: RATE * 5,
    },
  },
  summaryTrendStats: TREND_STATS,
};

// One counter per instance and outcome, so the summary keeps them apart.
const counters = GATEWAYS.map((_, i) => {
  const instance = String.fromCharCode(97 + i);
  return {
    admitted: new Counter(`rl_admitted_${instance}`),
    rejected: new Counter(`rl_rejected_${instance}`),
    other: new Counter(`rl_other_${instance}`),
  };
});
const admitted = new Counter('rl_admitted');
const rejected = new Counter('rl_rejected');
const other = new Counter('rl_other');
const sentAt = new Gauge('rl_sent_at_ms');

export function setup() {
  for (const set of [...counters, { admitted, rejected, other }]) {
    for (const counter of Object.values(set)) counter.add(0);
  }
  const admin = login();
  const key = createKey(admin, 'bench-ratelimit', {
    requestsPerMinute: RPM,
    tokensPerMinute: null,
    concurrentRequests: null,
  });
  return { authorization: `Bearer ${key.secret}` };
}

export default function (data) {
  const index = exec.scenario.iterationInTest % GATEWAYS.length;
  sentAt.add(Date.now());
  const res = http.post(
    `${GATEWAYS[index]}/v1/chat/completions`,
    chatBody({
      model: GATEWAY_MODEL,
      prompt: 'Rate limit check.',
      stream: false,
      temperature: 0.7,
    }),
    {
      headers: { 'content-type': 'application/json', authorization: data.authorization },
      tags: { kind: 'chat' },
    },
  );
  let outcome = 'other';
  if (res.status === 200) outcome = 'admitted';
  else if (res.status === 429 && res.json('error.code') === 'rpm_limit_exceeded')
    outcome = 'rejected';
  counters[index][outcome].add(1);
  ({ admitted, rejected, other })[outcome].add(1);
}

export const handleSummary = writeSummary({
  scenario: 'ratelimit',
  rpm: RPM,
  rate: RATE,
  duration: DURATION,
  instances: GATEWAYS.length,
});
