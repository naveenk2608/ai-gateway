#!/usr/bin/env node
/**
 * Sends a handful of varied requests to a running gateway, so the live demo carries real traffic
 * (M11). Run by .github/workflows/traffic.yml every two hours; CI runs the dry run.
 *
 *   node scripts/traffic.mjs [--base-url URL] [--api-key KEY] [--dry-run] [--wait-seconds N]
 *
 * The URL and key default to DEMO_BASE_URL and DEMO_API_KEY. The script first waits (up to two
 * minutes by default) for a sleeping free host to wake: it polls GET /ready until it answers 200.
 * Then it sends each request once, in order, and prints one line per request. It exits 1 if the
 * gateway never woke or no request succeeded; a request refused by a quota or budget is reported,
 * not fatal. --dry-run prints the plan and sends nothing.
 *
 * Plain Node 22 (global fetch), no dependencies, so the workflow needs no install step.
 */

const PROMPTS = [
  'In one sentence, what does an API gateway do?',
  'Name three prime numbers greater than 50.',
  'Translate "good morning" into French and Spanish.',
  'Give a one-line tip for writing readable code.',
  'What is the boiling point of water at sea level, in Celsius?',
  'Suggest a short name for a cat that likes boxes.',
];

/** The same prompt every run, sent twice at temperature 0: the second can be a cache hit. */
const REPEATED = 'Reply with the single word: pong.';

/**
 * The requests one run sends: every chat route, streaming and not, with small output caps. The
 * prompts rotate with the hour, so runs differ while each stays repeatable.
 */
export function plan(now = new Date()) {
  const pick = (offset) => PROMPTS[(now.getUTCHours() + offset) % PROMPTS.length];
  const chat = (name, model, prompt, { stream = false, maxTokens = 48, cache = false } = {}) => ({
    name,
    stream,
    headers: cache ? { 'x-gateway-cache': 'on' } : {},
    body: {
      model,
      stream,
      max_tokens: maxTokens,
      ...(cache ? { temperature: 0 } : {}),
      messages: [{ role: 'user', content: prompt }],
    },
  });
  return [
    chat('default', 'chat-default', pick(0), { maxTokens: 32 }),
    chat('fast, streamed', 'chat-fast', pick(1), { stream: true }),
    chat('cheap', 'chat-cheap', pick(2), { maxTokens: 32 }),
    chat('variety, streamed', 'chat-variety', pick(3), { stream: true }),
    chat('repeated', 'chat-default', REPEATED, { maxTokens: 8, cache: true }),
    chat('repeated again', 'chat-default', REPEATED, { maxTokens: 8, cache: true }),
  ];
}

function parseArgs(argv) {
  const args = { dryRun: false, waitSeconds: 120 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (arg === '--api-key') args.apiKey = argv[++i];
    else if (arg === '--wait-seconds') args.waitSeconds = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.waitSeconds) || args.waitSeconds < 0) {
    throw new Error('--wait-seconds must be a number of seconds');
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls GET /ready until it answers 200; a free host can take a minute or more to wake. */
async function waitForGateway(baseUrl, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return attempt;
      console.log(`waiting for the gateway: /ready answered ${res.status}`);
    } catch (err) {
      console.log(`waiting for the gateway: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (Date.now() >= deadline) return 0;
    await sleep(5_000);
  }
}

/** Reads a stream to its end and returns the usage from its last chunk, if any. */
async function readStream(res) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of res.body) text += decoder.decode(chunk, { stream: true });
  let usage = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.usage) usage = data.usage;
    } catch {
      // A keep-alive or partial line: nothing to read.
    }
  }
  return usage;
}

async function send(baseUrl, apiKey, request) {
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(60_000),
    });
    let usage = null;
    let error = null;
    if (res.ok && request.stream) usage = await readStream(res);
    else {
      const body = await res.json().catch(() => null);
      usage = body?.usage ?? null;
      error = body?.error?.code ?? null;
    }
    return {
      ok: res.ok,
      status: res.status,
      error,
      deployment: res.headers.get('x-gateway-deployment'),
      cache: res.headers.get('x-gateway-cache'),
      tokens: usage?.total_tokens ?? null,
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      deployment: null,
      cache: null,
      tokens: null,
      ms: Math.round(performance.now() - started),
    };
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const baseUrl = (args.baseUrl ?? env.DEMO_BASE_URL ?? '').replace(/\/+$/, '');
  const apiKey = args.apiKey ?? env.DEMO_API_KEY ?? '';
  const requests = plan();

  if (args.dryRun) {
    console.log(`dry run: ${requests.length} requests to ${baseUrl || '<DEMO_BASE_URL>'}`);
    for (const r of requests) {
      const extra = Object.keys(r.headers).length > 0 ? ` ${JSON.stringify(r.headers)}` : '';
      console.log(`  POST /v1/chat/completions ${r.name}: ${JSON.stringify(r.body)}${extra}`);
    }
    return 0;
  }
  if (!/^https?:\/\/[^/]+/.test(baseUrl)) {
    console.error('set DEMO_BASE_URL (or --base-url) to the gateway, e.g. https://example.com');
    return 1;
  }
  if (!apiKey) {
    console.error('set DEMO_API_KEY (or --api-key) to an API key of the demo project');
    return 1;
  }

  const woke = await waitForGateway(baseUrl, args.waitSeconds);
  if (woke === 0) {
    console.error(`the gateway did not answer /ready within ${args.waitSeconds} s`);
    return 1;
  }
  console.log(`gateway ready after ${woke} check(s)`);

  let succeeded = 0;
  for (const request of requests) {
    const r = await send(baseUrl, apiKey, request);
    if (r.ok) succeeded++;
    const facts = [
      `${r.status}`,
      r.deployment && `deployment ${r.deployment}`,
      r.cache && `cache ${r.cache}`,
      r.tokens !== null && `${r.tokens} tokens`,
      `${r.ms} ms`,
      r.error && `error ${r.error}`,
    ].filter(Boolean);
    console.log(`${request.name}: ${facts.join(', ')}`);
  }
  console.log(`${succeeded} of ${requests.length} requests succeeded`);
  return succeeded > 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('traffic.mjs')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
