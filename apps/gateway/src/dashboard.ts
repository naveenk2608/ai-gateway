import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ConfigError } from '@ai-gateway/shared';
import type { FastifyInstance } from 'fastify';

/** Where the dashboard is served: same origin as the admin API, so its session cookie applies. */
export const DASHBOARD_PATH = '/dashboard/';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Types worth compressing; images other than SVG and fonts are compressed already. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);

/**
 * The dashboard's own scripts, styles and connections only; nothing may frame it. Inline styles
 * are allowed because the chart library sets style attributes.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export interface StaticFile {
  body: Buffer;
  gzipped: Buffer | null;
  type: string;
  /** Vite names files in assets/ by their content hash, so they never change. */
  immutable: boolean;
}

/** The built dashboard, by path below DASHBOARD_PATH (`index.html`, `assets/index-abc.js`). */
export type DashboardFiles = ReadonlyMap<string, StaticFile>;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
}

/**
 * Reads the built dashboard (`vite build` output) into memory once at startup, so no request
 * path ever reaches the file system. Throws a ConfigError when `dir` holds no index.html.
 */
export function loadDashboard(dir: string): DashboardFiles {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ConfigError([`DASHBOARD_DIR: ${dir} is not a directory; build the dashboard first`]);
  }
  const files = new Map<string, StaticFile>();
  for (const path of walk(dir)) {
    const name = relative(dir, path).split(sep).join('/');
    const ext = extname(name).toLowerCase();
    const body = readFileSync(path);
    files.set(name, {
      body,
      gzipped: COMPRESSIBLE.has(ext) ? gzipSync(body) : null,
      type: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      immutable: name.startsWith('assets/'),
    });
  }
  if (!files.has('index.html')) {
    throw new ConfigError([`DASHBOARD_DIR: ${dir} has no index.html; build the dashboard first`]);
  }
  return files;
}

const acceptsGzip = (header: string | undefined) => header !== undefined && /\bgzip\b/.test(header);

/**
 * GET /dashboard/ and its files. Pages are routed in the URL hash, so only real files exist;
 * any other path gets the gateway's JSON 404. `/dashboard` redirects to `/dashboard/` so the
 * page's relative asset URLs resolve.
 */
export function registerDashboard(app: FastifyInstance, files: DashboardFiles): void {
  app.get('/dashboard', { schema: { hide: true } }, (_request, reply) =>
    reply.redirect(DASHBOARD_PATH),
  );
  // Asset requests would fill the info log; errors still show.
  app.get('/dashboard/*', { schema: { hide: true }, logLevel: 'warn' }, (request, reply) => {
    const name = (request.params as { '*': string })['*'] || 'index.html';
    const file = files.get(name);
    if (!file) return reply.callNotFound();
    void reply
      .header('content-type', file.type)
      .header('cache-control', file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('content-security-policy', CONTENT_SECURITY_POLICY)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('vary', 'Accept-Encoding');
    if (file.gzipped && acceptsGzip(request.headers['accept-encoding'])) {
      return reply.header('content-encoding', 'gzip').send(file.gzipped);
    }
    return reply.send(file.body);
  });
}
