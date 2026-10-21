/**
 * `pnpm bench:report`: turns a benchmark run in bench/results/<run>/ (the newest by default) into
 * docs/benchmarks.md. Every number in the report is read or computed from the run's files, and
 * every table links to the file its numbers came from (ADR 019).
 *
 *   pnpm bench:report               write docs/benchmarks.md from the newest run
 *   pnpm bench:report --run <dir>   use that run instead
 *   pnpm bench:report --check       fail if docs/benchmarks.md differs from what the run generates
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Run directories are named `<UTC date>T<hhmm>Z-<commit>`, so names sort by time. */
export const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{4}Z-[0-9a-f]{7}$/;

interface Metric {
  type: string;
  values: Record<string, number>;
}

interface Summary {
  bench: Record<string, unknown>;
  state: { testRunDurationMs: number };
  metrics: Record<string, Metric>;
}

interface ScenarioRun {
  name: string;
  script: string;
  env: Record<string, string>;
  wallClockMs: number;
}

interface Machine {
  runId: string;
  generatedAt: string;
  git: { commit: string; dirty: boolean };
  build: string;
  host: {
    cpuModel: string | null;
    vcpus: number;
    memoryBytes: number;
    arch: string;
    kernel: string;
    os: string | null;
    virtualization: { hypervisorFlag: boolean; detected: string | null };
  };
  docker: { server: string; compose: string };
  versions: { k6: string; nodeInGatewayImage: string };
  images: { image: string }[];
  config: {
    gateway: Record<string, string>;
    gatewayInstances: number;
    worker: Record<string, string>;
    mock: Record<string, string>;
  };
  scenarios: ScenarioRun[];
  totalWallClockMs: number;
}

/** A run with its machine file and every scenario summary it lists. */
export interface Run {
  id: string;
  machine: Machine;
  summaries: Map<string, Summary>;
}

export class ReportError extends Error {}

function readJson(path: string, label: string): unknown {
  if (!existsSync(path)) throw new ReportError(`${label} is missing`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ReportError(`${label} is not valid JSON`);
  }
}

/** Reads a run; fails if machine.json or any summary it lists is missing. */
export function loadRun(dir: string, label = dir): Run {
  const machine = readJson(join(dir, 'machine.json'), `${label}/machine.json`) as Machine;
  if (!Array.isArray(machine.scenarios) || machine.scenarios.length === 0) {
    throw new ReportError(`${label}/machine.json lists no scenarios`);
  }
  const summaries = new Map<string, Summary>();
  for (const scenario of machine.scenarios) {
    const file = `${label}/${scenario.name}.json`;
    summaries.set(scenario.name, readJson(join(dir, `${scenario.name}.json`), file) as Summary);
  }
  return { id: machine.runId, machine, summaries };
}

/** The newest run directory under `resultsDir`, or null when there is none. */
export function latestRun(resultsDir: string): string | null {
  if (!existsSync(resultsDir)) return null;
  const runs = readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return runs.at(-1) ?? null;
}

// --- reading numbers: a missing value is an error, never a silent zero ---

function stat(run: Run, scenario: string, metric: string, key: string): number {
  const value = run.summaries.get(scenario)?.metrics[metric]?.values[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReportError(`${scenario}.json has no ${metric} ${key}`);
  }
  return value;
}

const count = (run: Run, scenario: string, metric: string) => stat(run, scenario, metric, 'count');

function setting(run: Run, scenario: string, key: string): unknown {
  const value = run.summaries.get(scenario)?.bench[key];
  if (value === undefined) throw new ReportError(`${scenario}.json has no bench.${key}`);
  return value;
}

// --- formatting ---

const fixed = (value: number, digits = 1) => value.toFixed(digits);
const ms = (value: number) => `${fixed(value)} ms`;
const signedMs = (value: number) => `${value >= 0 ? '+' : '−'}${fixed(Math.abs(value))} ms`;
const percent = (ratio: number) => `${fixed(ratio * 100)}%`;
const signedPercent = (ratio: number) =>
  `${ratio >= 0 ? '+' : '−'}${fixed(Math.abs(ratio) * 100)}%`;
const gib = (bytes: number) => `${fixed(bytes / 2 ** 30)} GiB`;
const seconds = (millis: number) => `${fixed(millis / 1000)} s`;
const minutes = (millis: number) => `${fixed(millis / 60_000)} min`;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

// --- sections ---

interface OverheadPair {
  vus: number;
  stream: boolean;
  direct: string;
  gateway: string;
}

function overheadPairs(run: Run): OverheadPair[] {
  const pairs = new Map<string, OverheadPair>();
  for (const s of run.machine.scenarios.filter((s) => s.script === 'overhead.js')) {
    const vus = Number(setting(run, s.name, 'vus'));
    const stream = setting(run, s.name, 'stream') === true;
    const target = setting(run, s.name, 'target');
    const key = `${stream}-${vus}`;
    const pair = pairs.get(key) ?? { vus, stream, direct: '', gateway: '' };
    if (target === 'direct') pair.direct = s.name;
    else if (target === 'gateway') pair.gateway = s.name;
    pairs.set(key, pair);
  }
  const list = [...pairs.values()];
  for (const pair of list) {
    if (!pair.direct || !pair.gateway) {
      throw new ReportError(`overhead at ${pair.vus} VUs lacks a direct or a gateway run`);
    }
  }
  return list.sort((a, b) => Number(a.stream) - Number(b.stream) || a.vus - b.vus);
}

/** Completed requests per second, between the first request sent and the last answer. */
function throughput(run: Run, scenario: string): number {
  const windowMs =
    stat(run, scenario, 'bench_done_at_ms', 'max') - stat(run, scenario, 'bench_sent_at_ms', 'min');
  return count(run, scenario, 'bench_completed') / (windowMs / 1000);
}

function overheadTable(run: Run, pairs: OverheadPair[], stream: boolean, link: Link): string {
  const percentiles = ['p(50)', 'p(95)', 'p(99)'];
  const header = [
    'VUs',
    'Path',
    'Latency p50',
    'p95',
    'p99',
    ...(stream ? ['TTFT p50', 'TTFT p95', 'TTFT p99'] : []),
    'Requests/s',
    'Failed',
    'Source',
  ];
  const rows: string[][] = [];
  for (const pair of pairs.filter((p) => p.stream === stream)) {
    const measured = (scenario: string, path: string) => [
      String(pair.vus),
      path,
      ...percentiles.map((p) => ms(stat(run, scenario, 'bench_latency', p))),
      ...(stream ? percentiles.map((p) => ms(stat(run, scenario, 'bench_ttft', p))) : []),
      fixed(throughput(run, scenario)),
      String(count(run, scenario, 'bench_failed')),
      link(`${scenario}.json`),
    ];
    const added = (metric: string, p: string) =>
      signedMs(stat(run, pair.gateway, metric, p) - stat(run, pair.direct, metric, p));
    rows.push(measured(pair.direct, 'direct to mock'), measured(pair.gateway, 'through gateway'), [
      String(pair.vus),
      '**added by the gateway**',
      ...percentiles.map((p) => added('bench_latency', p)),
      ...(stream ? percentiles.map((p) => added('bench_ttft', p)) : []),
      signedPercent(throughput(run, pair.gateway) / throughput(run, pair.direct) - 1),
      '',
      'computed from the two rows above',
    ]);
  }
  return table(header, rows);
}

type Link = (file: string) => string;

function machineSection(run: Run, link: Link): string {
  const { machine } = run;
  const { host, config } = machine;
  const virtual = host.virtualization.hypervisorFlag
    ? 'virtual machine (hypervisor CPU flag set)'
    : 'no hypervisor flag';
  const overhead = run.machine.scenarios.find((s) => s.script === 'overhead.js');
  const rows = [
    [
      'Machine',
      `${host.cpuModel ?? 'unknown CPU'}, ${host.vcpus} vCPU, ${gib(host.memoryBytes)} memory, ${host.arch}; ${virtual}`,
    ],
    ['OS', `${host.os ?? 'unknown'}, ${host.kernel}`],
    ['Docker', `Engine ${machine.docker.server}, Compose ${machine.docker.compose}`],
    ['k6', `\`${machine.versions.k6}\` (container image)`],
    ['Node in the gateway image', machine.versions.nodeInGatewayImage],
    ['Images', machine.images.map((i) => `\`${i.image}\``).join(', ')],
    ['Images built', machine.build],
    [
      'Commit',
      `\`${machine.git.commit.slice(0, 7)}\`${machine.git.dirty ? ' (with uncommitted changes)' : ''}`,
    ],
    [
      'Gateway',
      `${config.gatewayInstances} instances, ${Object.entries(config.gateway)
        .filter(([k]) => ['LOG_LEVEL', 'CACHE_ENABLED', 'RUN_WORKER_IN_PROCESS'].includes(k))
        .map(([k, v]) => `\`${k}=${v}\``)
        .join(', ')}; other settings at their defaults`,
    ],
    [
      'Worker',
      Object.entries(config.worker)
        .filter(([k]) => k.startsWith('WORKER_'))
        .map(([k, v]) => `\`${k}=${v}\``)
        .join(', ') || 'defaults',
    ],
    ['Mock upstream', `\`MOCK_SETTINGS=${config.mock.MOCK_SETTINGS ?? '{}'}\``],
    [
      'Overhead runs',
      overhead ? `${String(setting(run, overhead.name, 'duration'))} each, closed loop` : 'none',
    ],
    [
      'Whole run',
      `${minutes(machine.totalWallClockMs)} wall clock, started ${machine.generatedAt}`,
    ],
  ];
  return `${table(['', `Source: ${link('machine.json')}`], rows)}`;
}

function rateLimitSection(run: Run, link: Link): string {
  const s = 'ratelimit';
  const rpm = Number(setting(run, s, 'rpm'));
  const windowMs = stat(run, s, 'rl_sent_at_ms', 'max') - stat(run, s, 'rl_sent_at_ms', 'min');
  const ceiling = Math.floor(rpm + (rpm * windowMs) / 60_000);
  const admitted = count(run, s, 'rl_admitted');
  const instances = Number(setting(run, s, 'instances'));
  const perInstance = Array.from({ length: instances }, (_, i) => {
    const name = String.fromCharCode(97 + i);
    return `${name}: ${count(run, s, `rl_admitted_${name}`)}`;
  }).join(', ');
  const sent =
    count(run, s, 'rl_admitted') + count(run, s, 'rl_rejected') + count(run, s, 'rl_other');
  return [
    `One key limited to ${rpm} requests per minute, ${String(setting(run, s, 'rate'))} requests per second for ${String(setting(run, s, 'duration'))}, alternating between ${instances} gateway instances. The bucket starts full and refills evenly, so over the ${seconds(windowMs)} between the first and the last request it can admit at most ${rpm} + ${rpm} per minute × ${fixed(windowMs / 60_000, 3)} min = **${ceiling}** (rounded down).`,
    '',
    table(
      [
        'Sent',
        'Admitted',
        'Ceiling',
        'Admitted / ceiling',
        'Rejected (`rpm_limit_exceeded`)',
        'Other',
        'Admitted per instance',
        'Result',
        'Source',
      ],
      [
        [
          String(sent),
          String(admitted),
          String(ceiling),
          percent(admitted / ceiling),
          String(count(run, s, 'rl_rejected')),
          String(count(run, s, 'rl_other')),
          perInstance,
          admitted <= ceiling && count(run, s, 'rl_other') === 0
            ? 'limit held'
            : '**limit exceeded**',
          link(`${s}.json`),
        ],
      ],
    ),
  ].join('\n');
}

function accountingSection(run: Run, link: Link): string {
  const s = 'accounting';
  const sent = count(run, s, 'acct_sent');
  const stored = count(run, s, 'acct_rows_stored');
  const distinct = count(run, s, 'acct_distinct_requests');
  const rollup = count(run, s, 'acct_rollup_requests');
  const failed = count(run, s, 'acct_failed');
  const fault = setting(run, s, 'fault') as Record<string, number>;
  const ok = stored === sent && distinct === sent && rollup === sent && failed === 0;
  return [
    `${String(setting(run, s, 'rate'))} requests per second for ${String(setting(run, s, 'duration'))} across ${String(setting(run, s, 'instances'))} gateway instances, ${percent(Number(setting(run, s, 'streamingShare')))} of them streaming. During the load Postgres was paused at ${fault.postgresPausedAtS} s (the worker's batch stalls mid-insert), the worker killed with SIGKILL at ${fault.workerKilledAtS} s, Postgres resumed at ${fault.postgresUnpausedAtS} s and the worker started again at ${fault.workerStartedAtS} s (seconds after k6 started). After the stream drained, the stored rows were counted for the run's key.`,
    '',
    table(
      [
        'Sent',
        'Answered',
        'Failed',
        'Rows stored',
        'Distinct request IDs',
        'Counted in rollups',
        'Re-delivered after the kill',
        'Dead letters',
        'Result',
        'Source',
      ],
      [
        [
          String(sent),
          String(count(run, s, 'acct_completed')),
          String(failed),
          String(stored),
          String(distinct),
          String(rollup),
          String(count(run, s, 'acct_worker_reclaimed')),
          String(count(run, s, 'acct_dead_letters')),
          ok ? 'each request stored once' : '**mismatch**',
          link(`${s}.json`),
        ],
      ],
    ),
  ].join('\n');
}

function cacheSection(run: Run, link: Link): string {
  const s = 'cache';
  const sent = count(run, s, 'cache_sent');
  const hits = count(run, s, 'cache_hits');
  const misses = count(run, s, 'cache_misses');
  const prompts = Number(setting(run, s, 'prompts'));
  const upstream = count(run, s, 'cache_upstream_requests');
  return [
    `${prompts} distinct prompts at temperature ${String(setting(run, s, 'temperature'))}, repeated at ${String(setting(run, s, 'rate'))} requests per second for ${String(setting(run, s, 'duration'))} across ${String(setting(run, s, 'instances'))} gateway instances sharing one cache. The best possible ratio misses each prompt once: (${sent} − ${prompts}) / ${sent}.`,
    '',
    table(
      [
        'Sent',
        'Hits',
        'Misses',
        'Failed',
        'Hit ratio',
        'Best possible',
        'Calls that reached the mock',
        'Result',
        'Source',
      ],
      [
        [
          String(sent),
          String(hits),
          String(misses),
          String(count(run, s, 'cache_failed')),
          percent(hits / sent),
          percent(1 - prompts / sent),
          String(upstream),
          upstream === misses ? 'mock calls = misses' : '**mock calls ≠ misses**',
          link(`${s}.json`),
        ],
      ],
    ),
  ].join('\n');
}

/** The report for a run. `resultsPath` is the run directory relative to docs/. */
export function renderReport(run: Run, resultsPath: string): string {
  const link: Link = (file) => `[${file}](${resultsPath}/${file})`;
  const pairs = overheadPairs(run);
  const { host } = run.machine;
  const first = pairs[0];
  return `${[
    '# Benchmarks',
    '',
    `<!-- Generated by \`pnpm bench:report\` from ${resultsPath}/. Do not edit: CI fails when this file differs from what the results generate. -->`,
    '',
    `Run \`${run.id}\` ([files](${resultsPath}/)). Every number below is read from, or computed from, the k6 summary or machine file linked beside it.`,
    '',
    `> **Cloud VM numbers.** This run used one cloud virtual machine (${host.vcpus} vCPU, ${gib(host.memoryBytes)}), where k6, the gateway instances, the worker, the mock provider, Redis and Postgres all ran in Docker side by side. The numbers describe that setup only. They are not measurements of the Render demo and not a claim about production capacity.`,
    '',
    '## Machine and configuration',
    '',
    machineSection(run, link),
    '',
    '## Gateway overhead',
    '',
    `Each row is one k6 run of closed-loop virtual users (VUs) sending the same chat completion (\`max_tokens\` ${first ? String(setting(run, first.direct, 'maxTokens')) : '-'}, \`temperature\` ${first ? String(setting(run, first.direct, 'temperature')) : '-'}, so the cache never answers) either straight to the HTTP mock provider or through one gateway instance to the same mock. The gateway path includes API-key authentication, the Redis admission check (the key has limits it never reaches), routing, the upstream call and publishing the usage event. Latency is the whole response; TTFT is the time to the first response byte, which both servers send with the first token. Requests/s counts completed requests between the first request sent and the last answer.`,
    '',
    '### Non-streaming',
    '',
    overheadTable(run, pairs, false, link),
    '',
    '### Streaming',
    '',
    overheadTable(run, pairs, true, link),
    '',
    '## Correctness under load',
    '',
    `### Rate limit across ${String(setting(run, 'ratelimit', 'instances'))} gateway instances`,
    '',
    rateLimitSection(run, link),
    '',
    '### Usage accounting through a worker crash',
    '',
    accountingSection(run, link),
    '',
    `### Cache hit ratio for a repeated temperature-${String(setting(run, 'cache', 'temperature'))} workload`,
    '',
    cacheSection(run, link),
    '',
    '## Limitations',
    '',
    `- Everything shared one machine of ${host.vcpus} vCPU: k6 itself, both gateway instances, the worker, the mock, Redis and Postgres compete for CPU, and nothing is pinned. Added latency is therefore the gateway's cost on this machine at that load, including contention, not an isolated per-request cost.`,
    '- Containers talk over Docker bridge networking on one host; there is no real network latency between client, gateway and provider.',
    '- Each configuration ran once. There are no repetitions or confidence intervals, so small differences between rows are within run-to-run noise.',
    '- The upstream is the deterministic mock with fixed timing. Real providers add their own, variable latency; these numbers say nothing about them.',
    '- TTFT is the time to the first response byte as k6 sees it, not a token-level measurement inside the stream.',
    "- The gateways log every request at `info` to Docker's local log driver; the logging cost is included.",
    '- The rate-limit ceiling assumes the bucket starts full, as a key that has not been used does.',
    '- How many events are re-delivered after the worker kill depends on how many it had read but not stored at that moment; the check is that none is lost or stored twice either way.',
    '- Not measured: Ollama or any real model (no Ollama ran here), and the Render demo, which is never benchmarked.',
  ].join('\n')}\n`;
}

/** CLI entry: returns the exit code. */
export function main(argv: string[], root: string, out: (line: string) => void): number {
  const runIndex = argv.indexOf('--run');
  const resultsDir = join(root, 'bench', 'results');
  const runDir =
    runIndex >= 0
      ? resolve(argv[runIndex + 1] ?? '')
      : (() => {
          const latest = latestRun(resultsDir);
          return latest === null ? null : join(resultsDir, latest);
        })();
  if (runDir === null) {
    out('no benchmark runs in bench/results; run `pnpm bench` first');
    return 1;
  }
  const docsPath = join(root, 'docs', 'benchmarks.md');
  let report: string;
  try {
    const label = relative(root, runDir);
    report = renderReport(loadRun(runDir, label), relative(dirname(docsPath), runDir));
  } catch (err) {
    if (err instanceof ReportError) {
      out(err.message);
      return 1;
    }
    throw err;
  }
  if (argv.includes('--check')) {
    const current = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : '';
    if (current === report) {
      out(`docs/benchmarks.md matches ${relative(root, runDir)}`);
      return 0;
    }
    out(
      `docs/benchmarks.md differs from what ${relative(root, runDir)} generates; run \`pnpm bench:report\` and do not edit it by hand`,
    );
    return 1;
  }
  writeFileSync(docsPath, report);
  out(`wrote docs/benchmarks.md from ${relative(root, runDir)}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = main(process.argv.slice(2), root, (line) => process.stdout.write(`${line}\n`));
}
