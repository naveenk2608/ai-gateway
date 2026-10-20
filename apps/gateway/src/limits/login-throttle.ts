import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { GatewayError } from '../errors.js';
import type { FailMode } from './admission.js';
import type { Limiter } from './limiter.js';

export interface LoginThrottleOptions {
  limiter: Pick<Limiter, 'take'>;
  /** Attempts per minute for one email address, to slow password guessing on an account. */
  perEmail: number;
  /** Attempts per minute from one client IP, to slow guessing across many accounts. */
  perIp: number;
  failMode: FailMode;
}

/** Keys name a hash of the address, so no email address is stored in Redis. */
const emailKey = (email: string) =>
  `login:email:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;

/** Rate limits for POST /admin/auth/login, with the same Redis fail mode as /v1 (ADR 010). */
export class LoginThrottle {
  readonly #o: LoginThrottleOptions;

  constructor(options: LoginThrottleOptions) {
    this.#o = options;
  }

  /** Counts one attempt; throws a 429 (or a 503 in closed mode when Redis is down). */
  async check(email: string, ip: string, log: FastifyBaseLogger): Promise<void> {
    let retryAfterMs: number | null;
    try {
      retryAfterMs =
        (await this.#o.limiter.take(`login:ip:${ip}`, this.#o.perIp)) ??
        (await this.#o.limiter.take(emailKey(email), this.#o.perEmail));
    } catch (err) {
      if (this.#o.failMode === 'open') {
        log.warn({ err }, 'login limits unavailable; allowing the attempt (LIMITS_FAIL_MODE=open)');
        return;
      }
      log.error({ err }, 'login limits unavailable; rejecting (LIMITS_FAIL_MODE=closed)');
      throw new GatewayError('limits_unavailable', 'Log in again shortly.', {
        httpStatus: 503,
        retryable: true,
        retryAfterSeconds: 1,
      });
    }
    if (retryAfterMs === null) return;
    log.warn({ ip }, 'admin login rate limited');
    throw new GatewayError('too_many_login_attempts', 'Too many login attempts. Retry later.', {
      httpStatus: 429,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    });
  }
}
