import { describe, expect, it } from 'vitest';
import { api, ApiError, canManage, isUnauthenticated } from './api.js';
import { budgetShare, formatCount, formatLatency, formatUsd } from './format.js';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fn, calls };
}

describe('api', () => {
  it('calls /api with JSON and the same-origin session cookie', async () => {
    const f = fakeFetch(201, { ok: true });
    expect(await api('/admin/projects', { method: 'POST', body: { name: 'x' } }, f.fn)).toEqual({
      ok: true,
    });
    expect(f.calls[0]?.url).toBe('/api/admin/projects');
    expect(f.calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: '{"name":"x"}',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('turns an OpenAI-style error body into an ApiError', async () => {
    const f = fakeFetch(403, { error: { code: 'insufficient_role', message: 'Needs admin.' } });
    const err = await api('/admin/x', {}, f.fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'insufficient_role', message: 'Needs admin.' });
    expect(isUnauthenticated(err)).toBe(false);
  });

  it('recognises a missing session, an empty reply and an unreachable gateway', async () => {
    const unauthenticated = await api('/admin/me', {}, fakeFetch(401, {}).fn).catch(
      (e: unknown) => e,
    );
    expect(isUnauthenticated(unauthenticated)).toBe(true);
    expect(
      await api('/admin/auth/logout', { method: 'POST' }, fakeFetch(204, undefined).fn),
    ).toBeNull();
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(api('/admin/me', {}, down)).rejects.toMatchObject({ code: 'network_error' });
  });

  it('lets only admins and owners manage', () => {
    expect(canManage('viewer')).toBe(false);
    expect(canManage('admin')).toBe(true);
    expect(canManage('owner')).toBe(true);
  });
});

describe('formatting', () => {
  it('shows micro-dollars as dollars, with more places for fractions of a cent', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(11)).toBe('$0.000011');
    expect(formatUsd(1_234_567)).toBe('$1.23');
  });

  it('formats counts, latency and budget shares', () => {
    expect(formatCount(12_345)).toBe('12,345');
    expect(formatLatency(250)).toBe('250 ms');
    expect(formatLatency(1_500)).toBe('1.50 s');
    expect(budgetShare(250_000, 1_000_000)).toBe('25%');
    expect(budgetShare(1, null)).toBeNull();
    expect(budgetShare(5, 0)).toBe('over budget');
  });
});
