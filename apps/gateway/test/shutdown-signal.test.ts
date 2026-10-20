import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_PEPPER } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/slow-server.ts', import.meta.url));

type FixtureMessage = { type: 'listening'; port: number } | { type: 'slow-request-started' };

let child: ChildProcess | undefined;

function startFixture(env: Record<string, string>) {
  child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fixture], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'warn',
      API_KEY_PEPPER: TEST_PEPPER,
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const proc = child;

  const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
    proc.once('exit', (code) => resolve({ code, at: performance.now() }));
  });
  const nextMessage = <T extends FixtureMessage['type']>(type: T) =>
    new Promise<Extract<FixtureMessage, { type: T }>>((resolve, reject) => {
      const onMessage = (message: FixtureMessage) => {
        if (message.type !== type) return;
        proc.off('message', onMessage);
        resolve(message as Extract<FixtureMessage, { type: T }>);
      };
      proc.on('message', onMessage);
      proc.once('exit', (code) => reject(new Error(`fixture exited with ${code} before ${type}`)));
    });

  return { proc, exited, nextMessage };
}

// On Windows, process.kill(pid, 'SIGTERM') terminates the process without running handlers, so
// signal handling can only be exercised on POSIX. CI (ubuntu) and the Docker image run it.
describe.skipIf(process.platform === 'win32')('gateway process on SIGTERM', () => {
  afterEach(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    child = undefined;
  });

  it('lets a slow in-flight request finish, then exits with code 0', async () => {
    const fixtureProcess = startFixture({ SLOW_MS: '1500', SHUTDOWN_TIMEOUT_MS: '10000' });
    const { port } = await fixtureProcess.nextMessage('listening');

    const started = fixtureProcess.nextMessage('slow-request-started');
    const response = fetch(`http://127.0.0.1:${port}/slow`).then(async (res) => ({
      status: res.status,
      body: await res.json(),
      at: performance.now(),
    }));
    await started;

    fixtureProcess.proc.kill('SIGTERM');

    const res = await response;
    const exit = await fixtureProcess.exited;
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ done: true });
    expect(exit.code).toBe(0);
    expect(res.at).toBeLessThanOrEqual(exit.at);
  });

  it('exits with code 1 when a request outlives SHUTDOWN_TIMEOUT_MS', async () => {
    const fixtureProcess = startFixture({ SLOW_MS: '10000', SHUTDOWN_TIMEOUT_MS: '300' });
    const { port } = await fixtureProcess.nextMessage('listening');

    const started = fixtureProcess.nextMessage('slow-request-started');
    const response = fetch(`http://127.0.0.1:${port}/slow`);
    await started;

    fixtureProcess.proc.kill('SIGTERM');

    await expect(response).rejects.toThrow();
    expect((await fixtureProcess.exited).code).toBe(1);
  });
});
