import { describe, expect, it, vi } from 'vitest';
import { fetchGatewayStatus } from './gatewayStatus.js';

function respond(status: number, body: unknown) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    ),
  );
}

describe('fetchGatewayStatus', () => {
  it('maps a 200 /ready response to ready with each check', async () => {
    const fetchFn = respond(200, {
      status: 'ready',
      checks: {
        postgres: { status: 'ok', latencyMs: 3 },
        redis: { status: 'ok', latencyMs: 1 },
      },
    });
    expect(await fetchGatewayStatus(fetchFn)).toEqual({
      kind: 'ready',
      checks: [
        { name: 'postgres', ok: true, latencyMs: 3 },
        { name: 'redis', ok: true, latencyMs: 1 },
      ],
    });
    expect(fetchFn).toHaveBeenCalledWith('/ready', expect.anything());
  });

  it('maps a 503 /ready response to not_ready, marking failed checks', async () => {
    const fetchFn = respond(503, {
      status: 'not_ready',
      checks: {
        postgres: { status: 'ok', latencyMs: 4 },
        redis: { status: 'fail', reason: 'error', latencyMs: 0 },
      },
    });
    expect(await fetchGatewayStatus(fetchFn)).toEqual({
      kind: 'not_ready',
      checks: [
        { name: 'postgres', ok: true, latencyMs: 4 },
        { name: 'redis', ok: false, latencyMs: 0 },
      ],
    });
  });

  it('treats a network error as unreachable', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    expect(await fetchGatewayStatus(fetchFn)).toEqual({ kind: 'unreachable', httpStatus: null });
  });

  it('treats a proxy error page as unreachable with its status', async () => {
    const fetchFn = respond(502, '<html>Bad Gateway</html>');
    expect(await fetchGatewayStatus(fetchFn)).toEqual({ kind: 'unreachable', httpStatus: 502 });
  });

  it('treats a 503 without readiness checks (gateway shutting down) as unreachable', async () => {
    const fetchFn = respond(503, { error: { code: 'shutting_down' } });
    expect(await fetchGatewayStatus(fetchFn)).toEqual({ kind: 'unreachable', httpStatus: 503 });
  });
});
