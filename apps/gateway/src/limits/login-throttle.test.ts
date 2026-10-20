import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { GatewayError } from '../errors.js';
import { LoginThrottle } from './login-throttle.js';

function throttle(take: (name: string) => Promise<number | null>, failMode: 'closed' | 'open') {
  const names: string[] = [];
  const t = new LoginThrottle({
    limiter: {
      take: (name) => {
        names.push(name);
        return take(name);
      },
    },
    perEmail: 10,
    perIp: 30,
    failMode,
  });
  return {
    names,
    check: () => t.check('Admin@Example.com', '203.0.113.7', captureLogger().logger),
  };
}

describe('LoginThrottle', () => {
  it('counts the attempt per IP and per email, without the address in the key', async () => {
    const t = throttle(() => Promise.resolve(null), 'closed');
    await t.check();
    expect(t.names[0]).toBe('login:ip:203.0.113.7');
    expect(t.names[1]).toMatch(/^login:email:[0-9a-f]{32}$/);
  });

  it('rejects with 429 and retry-after when a bucket is empty', async () => {
    const t = throttle((name) => Promise.resolve(name.includes('email') ? 2_500 : null), 'closed');
    const err = await t.check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({
      httpStatus: 429,
      code: 'too_many_login_attempts',
      retryAfterSeconds: 3,
    });
  });

  it('follows the Redis fail mode', async () => {
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(throttle(down, 'closed').check()).rejects.toMatchObject({ httpStatus: 503 });
    await expect(throttle(down, 'open').check()).resolves.toBeUndefined();
  });
});
