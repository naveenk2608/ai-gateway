import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLogger, deferred } from '../test/helpers.js';
import { buildApp, type App } from './app.js';
import { drainAndClose } from './shutdown.js';

async function startSlowApp() {
  const { logger, lines } = captureLogger();
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const entered = deferred();
  const release = deferred();
  const events: string[] = [];

  app.get('/slow', async () => {
    entered.resolve();
    await release.promise;
    return { done: true };
  });
  app.get('/work', () => {
    events.push('work started');
    return { ok: true };
  });
  app.addHook('onResponse', (request, _reply, done) => {
    events.push(`response ${request.url}`);
    done();
  });
  app.addHook('onClose', (_instance, done) => {
    events.push('onClose');
    done();
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { app, port, lines, entered, release, events, url: `http://127.0.0.1:${port}` };
}

/** A raw socket, so a second request can be written on a connection that is still busy. */
async function rawConnection(port: number) {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let data = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => (data += chunk));
  const closed = new Promise<string>((resolve) => socket.on('close', () => resolve(data)));
  return { send: (raw: string) => socket.write(raw), closed };
}

function hasUrl(line: Record<string, unknown>, url: string): boolean {
  const req = line.req as { url?: string } | undefined;
  return req?.url === url;
}

describe('drainAndClose', () => {
  let app: App | undefined;

  afterEach(async () => {
    if (app?.server.listening) await app.close();
    app = undefined;
  });

  it('lets an in-flight request finish before closing', async () => {
    const slow = await startSlowApp();
    app = slow.app;

    const response = fetch(`${slow.url}/slow`);
    await slow.entered.promise;

    let settled = false;
    const drained = drainAndClose(slow.app, 5_000).then((outcome) => {
      settled = true;
      return outcome;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    slow.release.resolve();
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });
    expect(await drained).toBe('drained');
    expect(slow.events).toEqual(['response /slow', 'onClose']);
  });

  it('refuses new connections once draining starts', async () => {
    const slow = await startSlowApp();
    app = slow.app;

    const inFlight = fetch(`${slow.url}/slow`);
    await slow.entered.promise;
    const drained = drainAndClose(slow.app, 5_000);

    await expect(fetch(`${slow.url}/health`)).rejects.toThrow();

    slow.release.resolve();
    expect((await inFlight).status).toBe(200);
    expect(await drained).toBe('drained');
  });

  it('starts no new work for a request that arrives on a busy socket during the drain', async () => {
    const slow = await startSlowApp();
    app = slow.app;

    const conn = await rawConnection(slow.port);
    conn.send('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n');
    await slow.entered.promise;
    const drained = drainAndClose(slow.app, 5_000);

    // Pipelined on the busy socket after the drain began. Node dispatches it immediately.
    conn.send('GET /work HTTP/1.1\r\nHost: x\r\n\r\n');
    await vi.waitFor(() => {
      expect(slow.lines.some((l) => l.msg === 'incoming request' && hasUrl(l, '/work'))).toBe(true);
    });
    slow.release.resolve();

    // The in-flight response closes the socket; the pipelined request never runs its handler,
    // and the client retries it elsewhere, as HTTP/1.1 requires for unanswered pipelined requests.
    const raw = await conn.closed;
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
    expect(raw.toLowerCase()).toContain('connection: close');
    expect(raw.match(/HTTP\/1\.1 /g)).toHaveLength(1);
    expect(slow.events).not.toContain('work started');
    expect(await drained).toBe('drained');
  });

  it('returns timeout when closing resources hangs, instead of waiting forever', async () => {
    const { logger } = captureLogger();
    const stuck = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
    // Stands in for pool.end() waiting on a query to an unresponsive database.
    stuck.addHook('onClose', () => new Promise<void>(() => undefined));
    await stuck.listen({ host: '127.0.0.1', port: 0 });

    expect(await drainAndClose(stuck, 50)).toBe('timeout');
    expect(stuck.server.listening).toBe(false);
  });

  it('force-closes requests that outlive the timeout', async () => {
    const slow = await startSlowApp();
    app = slow.app;

    const response = fetch(`${slow.url}/slow`);
    await slow.entered.promise;

    expect(await drainAndClose(slow.app, 50)).toBe('timeout');
    await expect(response).rejects.toThrow();
    expect(slow.app.server.listening).toBe(false);
    slow.release.resolve();
  });
});
