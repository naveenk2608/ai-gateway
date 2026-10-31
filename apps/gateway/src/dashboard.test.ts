import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ConfigError } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogger } from '../test/helpers.js';
import { buildApp } from './app.js';
import { loadDashboard, type DashboardFiles } from './dashboard.js';

let dir: string;
let files: DashboardFiles;

const INDEX = '<!doctype html><title>AI Gateway</title><script src="./assets/index-abc123.js">';
const SCRIPT = 'console.log("dashboard");'.repeat(20);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashboard-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), SCRIPT);
  files = loadDashboard(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A gateway serving `dashboard`; null serves none. */
function app(dashboard: DashboardFiles | null = files) {
  const { logger } = captureLogger();
  return buildApp({
    logger,
    readiness: { checks: {}, timeoutMs: 50 },
    dashboard: dashboard ?? undefined,
  });
}

describe('the dashboard on the gateway', () => {
  it('redirects / and /dashboard to /dashboard/', async () => {
    const gateway = app();
    for (const path of ['/', '/dashboard']) {
      const res = await gateway.inject(path);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/dashboard/');
    }
  });

  it('serves index.html at /dashboard/, revalidated on every load, with a strict CSP', async () => {
    const res = await app().inject('/dashboard/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Same origin as the admin API: no CORS headers.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves hashed assets as immutable, gzipped when the browser accepts it', async () => {
    const gateway = app();
    const plain = await gateway.inject('/dashboard/assets/index-abc123.js');
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toBe(SCRIPT);
    expect(plain.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(plain.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const zipped = await gateway.inject({
      url: '/dashboard/assets/index-abc123.js',
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(zipped.rawPayload).toString()).toBe(SCRIPT);
    expect(zipped.rawPayload.length).toBeLessThan(SCRIPT.length);
  });

  it('answers unknown files and paths outside the build with the JSON 404', async () => {
    const gateway = app();
    for (const path of [
      '/dashboard/missing.js',
      '/dashboard/../package.json',
      '/dashboard/%2e%2e/%2e%2e/etc/passwd',
      '/dashboard/assets/',
    ]) {
      const res = await gateway.inject(path);
      expect(res.statusCode, path).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('is not served without DASHBOARD_DIR, and / goes to the API docs', async () => {
    const gateway = app(null);
    expect((await gateway.inject('/dashboard/')).statusCode).toBe(404);
    expect((await gateway.inject('/')).headers.location).toBe('/docs');
  });

  it('refuses a directory that is missing or has no index.html', () => {
    expect(() => loadDashboard(join(dir, 'nope'))).toThrow(ConfigError);
    expect(() => loadDashboard(join(dir, 'assets'))).toThrow(/no index\.html/);
  });
});
