import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { latestRun, loadRun, main, renderReport, ReportError } from './report.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixtureRun = join(fixtures, 'run');
const RUN_ID = '2026-10-21T0014Z-00f0bfc';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repo-like root with the fixture run in bench/results/<run>/ and an empty docs/. */
function tempRoot(): { root: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'bench-report-'));
  temps.push(root);
  const runDir = join(root, 'bench', 'results', RUN_ID);
  cpSync(fixtureRun, runDir, { recursive: true });
  mkdirSync(join(root, 'docs'));
  return { root, runDir };
}

function quiet() {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line) };
}

describe('renderReport', () => {
  it('turns the fixture summaries into the expected markdown', () => {
    const report = renderReport(loadRun(fixtureRun), 'fixtures/run');
    expect(report).toBe(readFileSync(join(fixtures, 'expected.md'), 'utf8'));
  });

  it('reads every number from the files: a changed result changes the report', () => {
    const { runDir } = tempRoot();
    const path = join(runDir, 'ratelimit.json');
    const summary = JSON.parse(readFileSync(path, 'utf8')) as {
      metrics: Record<string, { values: Record<string, number> }>;
    };
    summary.metrics.rl_admitted!.values.count = 91;
    writeFileSync(path, JSON.stringify(summary));
    const report = renderReport(loadRun(runDir), 'x');
    expect(report).toContain('| 91 | 90 |');
    expect(report).toContain('**limit exceeded**');
  });

  it('computes the added latency and the ceilings from the runs', () => {
    const report = renderReport(loadRun(fixtureRun), 'x');
    // Gateway p50 58.0 ms against direct 51.1 ms in the fixture.
    expect(report).toMatch(/\| 5 \| \*\*added by the gateway\*\* \| \+6\.9 ms \|/);
    expect(report).toContain('= **90** (rounded down)');
    expect(report).toContain(
      '| 1200 | 1200 | 0 | 1200 | 1200 | 1200 | 1 | 0 | each request stored once |',
    );
    expect(report).toContain('| 401 | 381 | 20 | 0 | 95.0% | 95.0% | 20 | mock calls = misses |');
    expect(report).toContain('Cloud VM numbers');
  });

  it('fails when a result file the run lists is missing', () => {
    const { runDir } = tempRoot();
    rmSync(join(runDir, 'cache.json'));
    expect(() => loadRun(runDir, 'run')).toThrow(new ReportError('run/cache.json is missing'));
  });

  it('fails when a summary lacks a metric instead of printing zero', () => {
    const { runDir } = tempRoot();
    const path = join(runDir, 'accounting.json');
    const summary = JSON.parse(readFileSync(path, 'utf8')) as { metrics: Record<string, unknown> };
    delete summary.metrics.acct_rows_stored;
    writeFileSync(path, JSON.stringify(summary));
    expect(() => renderReport(loadRun(runDir), 'x')).toThrow(
      'accounting.json has no acct_rows_stored count',
    );
  });
});

describe('pnpm bench:report', () => {
  it('picks the newest run directory', () => {
    const { root } = tempRoot();
    mkdirSync(join(root, 'bench', 'results', '2026-01-01T0000Z-aaaaaaa'));
    mkdirSync(join(root, 'bench', 'results', 'not-a-run'));
    expect(latestRun(join(root, 'bench', 'results'))).toBe(RUN_ID);
  });

  it('writes docs/benchmarks.md, then --check passes until someone edits it', () => {
    const { root } = tempRoot();
    const { out } = quiet();
    expect(main([], root, out)).toBe(0);
    const docs = join(root, 'docs', 'benchmarks.md');
    expect(readFileSync(docs, 'utf8')).toContain(`../bench/results/${RUN_ID}/ratelimit.json`);
    expect(main(['--check'], root, out)).toBe(0);

    writeFileSync(docs, readFileSync(docs, 'utf8').replace('| 90 | 90 |', '| 95 | 90 |'));
    const check = quiet();
    expect(main(['--check'], root, check.out)).toBe(1);
    expect(check.lines.join('\n')).toContain('do not edit it by hand');
  });

  it('--check fails when a referenced result file is missing', () => {
    const { root, runDir } = tempRoot();
    expect(main([], root, quiet().out)).toBe(0);
    rmSync(join(runDir, 'overhead-gateway-stream-5vu.json'));
    const check = quiet();
    expect(main(['--check'], root, check.out)).toBe(1);
    expect(check.lines).toEqual([
      `bench/results/${RUN_ID}/overhead-gateway-stream-5vu.json is missing`,
    ]);
  });

  it('fails when there is no run', () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-report-'));
    temps.push(root);
    const check = quiet();
    expect(main(['--check'], root, check.out)).toBe(1);
    expect(check.lines[0]).toContain('no benchmark runs');
  });
});
