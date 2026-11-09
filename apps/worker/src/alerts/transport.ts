import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Target } from './ssrf.js';

/** Sends one alert; resolves with the receiver's status, rejects on a network error or timeout. */
export type Transport = (
  target: Target,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<{ status: number }>;

/**
 * POST over https to the checked address only (ADR 033): the connection's DNS lookup returns the
 * address `vetTarget` approved, the TLS name stays the URL's host, redirects are not followed (a
 * 3xx is a failed delivery), the whole send has `timeoutMs`, and the reply's body is not read
 * beyond its status line and headers.
 */
export const httpsTransport: Transport = (target, body, headers, timeoutMs) =>
  new Promise((resolve, reject) => {
    const pinned: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    const req = request(
      target.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'ai-gateway-alerts',
          ...headers,
        },
        lookup: pinned,
      },
      (res) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0 });
        res.destroy();
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body);
  });
