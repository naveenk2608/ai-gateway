// Shared helpers for the k6 scenarios (M9, ADR 019). k6 runs these files itself (not Node), from
// the pinned grafana/k6 image, so they use only k6 modules.
import http from 'k6/http';

/** An environment value (`-e NAME=value`), or `fallback`. */
export function env(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
}

export function numberEnv(name, fallback) {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

/** Seconds in a k6 duration such as `20s` or `2m`. */
export function seconds(duration) {
  const match = /^(\d+)(s|m)$/.exec(duration);
  if (!match) throw new Error(`unsupported duration "${duration}" (use e.g. 20s or 2m)`);
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1);
}

export const GATEWAYS = env('GATEWAYS', 'http://gateway-a:8080,http://gateway-b:8080').split(',');
export const MOCK_URL = env('MOCK_URL', 'http://mock:8090');
/** The logical model clients send to the gateway, and the name the gateway sends upstream. */
export const GATEWAY_MODEL = 'bench-1';
export const UPSTREAM_MODEL = 'bench-mock';
export const MAX_TOKENS = 32;

/** Trend percentiles every summary keeps. */
export const TREND_STATS = ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'];

/** Logs in as the bench admin; returns the session cookie header and the project ID. */
export function login() {
  const base = GATEWAYS[0];
  const res = http.post(
    `${base}/admin/auth/login`,
    JSON.stringify({
      email: env('ADMIN_EMAIL', 'bench@example.com'),
      password: __ENV.ADMIN_PASSWORD,
    }),
    { headers: { 'content-type': 'application/json' }, tags: { kind: 'admin' } },
  );
  if (res.status !== 200) throw new Error(`admin login failed with ${res.status}`);
  const session = res.cookies.gw_session?.[0]?.value;
  if (!session) throw new Error('admin login set no session cookie');
  const admin = { cookie: `gw_session=${session}` };
  const me = adminGet(admin, '/admin/me');
  const projectId = me.projects[0]?.id;
  if (!projectId) throw new Error('the bench admin has no project');
  return { ...admin, projectId };
}

export function adminGet(admin, path) {
  const res = http.get(`${GATEWAYS[0]}${path}`, {
    headers: { cookie: admin.cookie },
    tags: { kind: 'admin' },
  });
  if (res.status !== 200) throw new Error(`GET ${path} failed with ${res.status}`);
  return res.json();
}

/** Creates an API key in the bench project; returns its ID and secret. */
export function createKey(admin, name, limits) {
  const res = http.post(
    `${GATEWAYS[0]}/admin/projects/${admin.projectId}/api-keys`,
    JSON.stringify({ name, limits }),
    {
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      tags: { kind: 'admin' },
    },
  );
  if (res.status !== 201) throw new Error(`creating key "${name}" failed with ${res.status}`);
  const body = res.json();
  return { id: body.apiKey.id, secret: body.key };
}

/** A chat completion request body; the direct path names the upstream model. */
export function chatBody({ model, prompt, stream, temperature }) {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: MAX_TOKENS,
    temperature,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
}

/** True for a complete answer: JSON with a choice, or a stream that reached `[DONE]`. */
export function completed(res, stream) {
  if (res.status !== 200 || typeof res.body !== 'string') return false;
  if (stream) return res.body.includes('data: [DONE]');
  try {
    return Array.isArray(res.json().choices);
  } catch {
    return false;
  }
}

/**
 * handleSummary for a scenario: writes the k6 summary, minus setup data (it holds API keys and
 * the session), with the scenario's settings, to /results/<name>.json. RESULT_NAME empty (the
 * warm-up) writes nothing.
 */
export function writeSummary(bench) {
  return (data) => {
    const name = env('RESULT_NAME', '');
    const summary = { ...data };
    delete summary.setup_data;
    const line = `${bench.scenario}: ${Math.round(data.state.testRunDurationMs / 1000)} s${name ? ` -> ${name}.json` : ' (not recorded)'}\n`;
    if (!name) return { stdout: line };
    const result = { bench, ...summary };
    return { stdout: line, [`/results/${name}.json`]: `${JSON.stringify(result, null, 2)}\n` };
  };
}
