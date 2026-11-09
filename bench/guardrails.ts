// How long the guardrail checks take on a large prompt (M16, ADR 035): every detector on `mask`
// plus a list of blocked words, over a chat request of about 100,000 characters with some values
// to find. Run with `pnpm bench:guardrails`; it prints the machine and the timings as JSON.
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { guardrailPolicySchema } from '../apps/gateway/src/guardrails/policy.js';
import { Findings, scanChatInput } from '../apps/gateway/src/guardrails/scan.js';
import type { ChatCompletionRequest } from '../apps/gateway/src/proxy/schema.js';

const policy = guardrailPolicySchema.parse({
  input: { email: 'mask', phone: 'mask', card: 'mask', aadhaar: 'mask', pan: 'mask' },
  blockedTerms: { terms: ['project titan', 'internal only', 'do not share'], action: 'flag' },
});

/** About `chars` characters of prose with an email, phone, card and PAN every ~2,000. */
function prompt(chars: number): string {
  const filler =
    'The quarterly report covers revenue, costs and the plan for the next release, with notes ' +
    'from each team on what went well and what did not, order 2024-118 and invoice 98431. ';
  const values =
    ' Contact jane.doe@example.com or +91 98765 43210, card 4111 1111 1111 1111, PAN ABCPE1234F. ';
  let out = '';
  while (out.length < chars) out += filler.repeat(10) + values;
  return out.slice(0, chars);
}

function measure(chars: number, runs: number) {
  const body: ChatCompletionRequest = {
    model: 'm',
    messages: [
      { role: 'system', content: 'You are a careful assistant.' },
      { role: 'user', content: prompt(chars) },
    ],
  };
  // Warm up the regular expressions and the JIT.
  for (let i = 0; i < 5; i++) scanChatInput(body, policy, new Findings());
  const times: number[] = [];
  let found = 0;
  for (let i = 0; i < runs; i++) {
    const findings = new Findings();
    const started = performance.now();
    scanChatInput(body, policy, findings);
    times.push(performance.now() - started);
    found = findings.list().reduce((n, f) => n + f.count, 0);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) =>
    Number(times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(2));
  return { chars, runs, valuesFound: found, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
}

console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      results: [measure(10_000, 200), measure(100_000, 100), measure(400_000, 20)],
    },
    null,
    2,
  ),
);
