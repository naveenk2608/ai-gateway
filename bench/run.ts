/**
 * `pnpm bench`: runs the M9 benchmarks (ADR 019) against the stack in bench/compose.yaml and
 * writes each k6 summary, plus machine.json (machine, images, config, timings), into
 * bench/results/<run>/. `pnpm bench:report` turns a run into docs/benchmarks.md.
 *
 *   pnpm bench               build the images, start the stack, run every scenario, remove it
 *   pnpm bench --no-build    reuse ai-gateway-bench/* images built earlier
 *   pnpm bench --out <dir>   write somewhere else (e.g. a trial run that is not committed)
 *
 * BENCH_VUS (10,50,100) and BENCH_OVERHEAD_DURATION (20s) change the overhead matrix;
 * BENCH_BUILD_NOTE says how prebuilt images were made (recorded with --no-build). k6 runs
 * from its pinned image; nothing is installed locally. The stack is removed with its volumes at
 * the end, also when a scenario fails; after an interrupted run, remove it with
 * `docker compose -f bench/compose.yaml down -v`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'bench', 'compose.yaml');
const K6_IMAGE = 'grafana/k6:2.3.0';
const GATEWAY_IMAGE = 'ai-gateway-bench/gateway:local';

interface Scenario {
  name: string;
  script: string;
  env: Record<string, string>;
  /** Steps run while k6 runs, at seconds after it started. */
  faults?: Fault[];
}

interface Fault {
  atS: number;
  action: 'pause' | 'kill' | 'unpause' | 'start';
  service: 'postgres' | 'worker';
}

function scenarios(vusList: number[], overheadDuration: string): Scenario[] {
  const list: Scenario[] = [];
  for (const vus of vusList) {
    for (const stream of [false, true]) {
      // Direct and gateway runs alternate, so slow drift on the machine affects both alike.
      for (const target of ['direct', 'gateway']) {
        list.push({
          name: `overhead-${target}-${stream ? 'stream' : 'plain'}-${vus}vu`,
          script: 'overhead.js',
          env: {
            TARGET: target,
            STREAM: String(stream),
            VUS: String(vus),
            DURATION: overheadDuration,
          },
        });
      }
    }
  }
  const faults: Fault[] = [
    { atS: 8, action: 'pause', service: 'postgres' },
    { atS: 11, action: 'kill', service: 'worker' },
    { atS: 13, action: 'unpause', service: 'postgres' },
    { atS: 14, action: 'start', service: 'worker' },
  ];
  list.push(
    { name: 'ratelimit', script: 'ratelimit.js', env: { RPM: '60', RATE: '10', DURATION: '30s' } },
    {
      name: 'accounting',
      script: 'accounting.js',
      env: {
        RATE: '40',
        DURATION: '30s',
        FAULT_PAUSE_AT_S: String(faults[0]!.atS),
        FAULT_KILL_AT_S: String(faults[1]!.atS),
        FAULT_UNPAUSE_AT_S: String(faults[2]!.atS),
        FAULT_START_AT_S: String(faults[3]!.atS),
      },
      faults,
    },
    { name: 'cache', script: 'cache.js', env: { PROMPTS: '20', RATE: '20', DURATION: '20s' } },
  );
  return list;
}

/** Runs a command; resolves with its output, or rejects with the last lines of it. */
function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; show?: boolean } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: options.env ?? process.env });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (options.show) process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(output.trim());
      else {
        const tail = output.trim().split('\n').slice(-15).join('\n');
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${tail}`));
      }
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryRun(command: string, args: string[]): Promise<string | null> {
  try {
    return await run(command, args);
  } catch {
    return null;
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

async function machineInfo() {
  const cpus = os.cpus();
  const cpuinfo = readIfExists('/proc/cpuinfo') ?? '';
  const osRelease = readIfExists('/etc/os-release') ?? '';
  return {
    cpuModel: cpus[0]?.model ?? null,
    vcpus: cpus.length,
    memoryBytes: os.totalmem(),
    arch: os.arch(),
    kernel: `${os.type()} ${os.release()}`,
    os: /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(osRelease)?.[1] ?? null,
    virtualization: {
      // Set by the CPU on virtual machines: these are cloud VM numbers, not bare metal.
      hypervisorFlag: /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo),
      detected: await tryRun('systemd-detect-virt', []),
      vendor: readIfExists('/sys/class/dmi/id/sys_vendor'),
      product: readIfExists('/sys/class/dmi/id/product_name'),
    },
  };
}

async function imageInfo(image: string) {
  const out = await run('docker', [
    'image',
    'inspect',
    '--format',
    '{{.Id}}|{{json .RepoDigests}}',
    image,
  ]);
  const [id, digests] = out.split('|');
  return { image, id, repoDigests: JSON.parse(digests ?? '[]') as string[] };
}

const SECRET_NAME = /KEY|PASSWORD|PEPPER|TOKEN|SECRET/;

function redact(environment: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment ?? {}).map(([k, v]) => [k, SECRET_NAME.test(k) ? '<redacted>' : v]),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const build = !args.includes('--no-build');
  const outIndex = args.indexOf('--out');
  const vusList = (process.env.BENCH_VUS ?? '10,50,100').split(',').map(Number);
  if (vusList.some((v) => !Number.isInteger(v) || v < 1))
    throw new Error('BENCH_VUS: e.g. 10,50,100');
  const overheadDuration = process.env.BENCH_OVERHEAD_DURATION ?? '20s';
  const list = scenarios(vusList, overheadDuration);

  const commit = await run('git', ['rev-parse', 'HEAD']);
  const dirty = (await run('git', ['status', '--porcelain', '--', '.', ':!bench/results'])) !== '';
  const now = new Date();
  const runId = `${now.toISOString().slice(0, 16).replace(':', '')}Z-${commit.slice(0, 7)}`;
  const outDir =
    outIndex >= 0 ? resolve(args[outIndex + 1] ?? '') : join(root, 'bench', 'results', runId);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new Error(`${outDir} is not empty`);
  }
  mkdirSync(outDir, { recursive: true });

  // Per-run secrets, only ever in this process's environment and the containers'.
  const password = randomBytes(18).toString('base64url');
  const pepper = randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    BENCH_API_KEY_PEPPER: pepper,
    BENCH_ADMIN_PASSWORD: password,
    BENCH_RESULTS_DIR: outDir,
  };
  const compose = (...rest: string[]) => ['compose', '-f', composeFile, ...rest];
  const say = (line: string) => process.stdout.write(`${line}\n`);

  say(`bench run ${runId} -> ${relative(root, outDir) || outDir}`);
  const timings: Record<string, unknown>[] = [];
  const started = Date.now();
  try {
    await run('docker', compose('down', '-v', '--remove-orphans'), { env });
    if (build) {
      say('building images');
      await run('docker', compose('build', '--quiet'), { env });
    }
    say('starting the stack');
    await run('docker', compose('up', '-d', '--no-build', '--wait'), { env });
    const container = async (service: string) =>
      run('docker', compose('ps', '-aq', service), { env });
    const ids = { postgres: await container('postgres'), worker: await container('worker') };

    const k6 = (scenario: Pick<Scenario, 'script' | 'env'>, resultName: string) => {
      const flags = Object.entries({
        ...scenario.env,
        RESULT_NAME: resultName,
        ADMIN_PASSWORD: password,
      }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
      return run(
        'docker',
        compose(
          '--profile',
          'tools',
          'run',
          '--rm',
          '--no-deps',
          '--user',
          user,
          'k6',
          'run',
          '--quiet',
          ...flags,
          `/scripts/${scenario.script}`,
        ),
        { env },
      );
    };

    // Warm-up, not recorded: JIT, connection pools, key caches.
    for (const target of ['direct', 'gateway']) {
      say(`warm-up ${target}`);
      await k6(
        {
          script: 'overhead.js',
          env: { TARGET: target, STREAM: 'false', VUS: '10', DURATION: '10s' },
        },
        '',
      );
    }

    for (const scenario of list) {
      const t0 = Date.now();
      const faultsDone = (scenario.faults ?? []).map(async (fault) => {
        await sleep(fault.atS * 1000);
        await run('docker', [
          fault.action,
          ...(fault.action === 'kill' ? ['-s', 'KILL'] : []),
          ids[fault.service],
        ]);
        say(`  ${fault.action} ${fault.service} at ${fault.atS} s`);
      });
      const [result, ...faults] = await Promise.allSettled([
        k6(scenario, scenario.name),
        ...faultsDone,
      ]);
      for (const settled of [result, ...faults]) {
        if (settled.status === 'rejected') throw settled.reason;
      }
      const output = result.status === 'fulfilled' ? result.value : '';
      const t1 = Date.now();
      say(
        output
          .split('\n')
          .filter((l) => !l.includes('Container'))
          .at(-1) ?? scenario.name,
      );
      timings.push({
        name: scenario.name,
        script: scenario.script,
        env: scenario.env,
        startedAt: new Date(t0).toISOString(),
        wallClockMs: t1 - t0,
      });
    }

    const config = JSON.parse(
      await run('docker', compose('config', '--format', 'json'), { env }),
    ) as { services: Record<string, { environment?: Record<string, string>; image?: string }> };
    const images = await Promise.all(
      ['postgres', 'redis', 'gateway-a', 'worker']
        .map((s) => config.services[s]?.image)
        .filter((image): image is string => image !== undefined)
        .concat(K6_IMAGE)
        .map(imageInfo),
    );
    const machine = {
      runId,
      generatedAt: now.toISOString(),
      git: { commit, dirty },
      build: build
        ? 'docker compose build'
        : `prebuilt images (--no-build)${process.env.BENCH_BUILD_NOTE ? `: ${process.env.BENCH_BUILD_NOTE}` : ''}`,
      host: await machineInfo(),
      docker: {
        server: await run('docker', ['version', '--format', '{{.Server.Version}}']),
        compose: await run('docker', ['compose', 'version', '--short']),
      },
      versions: {
        k6: (await run('docker', ['run', '--rm', K6_IMAGE, 'version'])).split('\n')[0],
        nodeInGatewayImage: await run('docker', [
          'run',
          '--rm',
          '--entrypoint',
          'node',
          GATEWAY_IMAGE,
          '-v',
        ]),
      },
      images,
      config: {
        gateway: redact(config.services['gateway-a']?.environment),
        gatewayInstances: ['gateway-a', 'gateway-b'].filter((s) => config.services[s]).length,
        worker: redact(config.services.worker?.environment),
        mock: redact(config.services.mock?.environment),
        models: JSON.parse(readFileSync(join(root, 'bench', 'models.json'), 'utf8')) as unknown,
      },
      scenarios: timings,
      totalWallClockMs: Date.now() - started,
    };
    writeFileSync(join(outDir, 'machine.json'), `${JSON.stringify(machine, null, 2)}\n`);

    // Nothing written may hold the run's secrets or an API key.
    const leaks = readdirSync(outDir).filter((file) => {
      const text = readFileSync(join(outDir, file), 'utf8');
      return (
        text.includes(password) ||
        text.includes(pepper) ||
        /gw_[0-9a-f]{16}_[0-9a-f]{64}|gw_session=/.test(text)
      );
    });
    if (leaks.length > 0)
      throw new Error(`secrets found in ${leaks.join(', ')}; do not commit them`);
    say(`done in ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    say('removing the stack');
    await run('docker', compose('down', '-v', '--remove-orphans'), { env });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
