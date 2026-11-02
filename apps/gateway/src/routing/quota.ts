import type { Clock } from '@ai-gateway/shared';
import type { Logger, Redis } from '@ai-gateway/shared/node';
import { LuaScript } from '../limits/scripts.js';
import type { RateLimitHeaders } from '../providers/types.js';

/** A deployment's free-tier limits from the models file; any of them may be absent. */
export interface QuotaLimits {
  requestsPerMinute?: number | undefined;
  requestsPerDay?: number | undefined;
  tokensPerMinute?: number | undefined;
  tokensPerDay?: number | undefined;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Counters outlive their window by this much, so late corrections still find them. */
const GRACE_MS = 60_000;
/** The longest a quota check may wait for Redis before it fails open (ADR 025). */
const CHECK_TIMEOUT_MS = 250;

/** The UTC minute and day containing `now`: the fixed windows quotas are counted in. */
export function quotaWindows(now: number): { minute: number; day: number } {
  return { minute: now - (now % MINUTE_MS), day: now - (now % DAY_MS) };
}

/** Milliseconds until the window that started at `start` (of length `length`) ends. */
export function untilWindowEnd(start: number, length: number, now: number): number {
  return Math.max(1, start + length - now);
}

export type QuotaWindow = 'minute' | 'day';
export type QuotaUnit = 'requests' | 'tokens';

/** Why a deployment was skipped, in the words stored on the next attempt's routing reason. */
export function describeSkip(
  unit: QuotaUnit,
  window: QuotaWindow,
  used: number,
  limit: number,
): string {
  const when = window === 'day' ? 'today' : 'this minute';
  return `quota, ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} ${unit} ${when}`;
}

/** Counts held for one try, corrected to the tokens used when it ends. */
export interface QuotaTicket {
  minuteKey: string;
  dayKey: string;
  /** Tokens counted up front: the prompt estimate plus the output cap. */
  tokens: number;
}

export type QuotaCheck =
  | { ok: true; ticket: QuotaTicket | null }
  | { ok: false; kind: 'quota' | 'cooldown'; reason: string; retryAfterMs: number };

/**
 * Checks a deployment's cooldown and quota in one step and, if it may be tried, counts one request
 * and the tokens it may use. Fixed UTC windows: KEYS minute and day hashes (fields req, tok) and
 * the cooldown key. ARGV: limits per minute and day for requests and tokens (0 = none), whether to
 * count at all, the tokens, each window's expiry (ms since the epoch), whether to ignore the
 * cooldown. Replies {1} when admitted, {0, 'cooldown', ms} or {0, unit, window, used, limit}.
 */
const ACQUIRE = new LuaScript(`
if ARGV[9] ~= '1' then
  local cooldown = redis.call('PTTL', KEYS[3])
  if cooldown > 0 then return {0, 'cooldown', cooldown} end
end
if ARGV[5] ~= '1' then return {1} end
local tokens = tonumber(ARGV[6])
local mreq = tonumber(redis.call('HGET', KEYS[1], 'req') or '0')
local mtok = tonumber(redis.call('HGET', KEYS[1], 'tok') or '0')
local dreq = tonumber(redis.call('HGET', KEYS[2], 'req') or '0')
local dtok = tonumber(redis.call('HGET', KEYS[2], 'tok') or '0')
local rpm, rpd, tpm, tpd = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
if rpd > 0 and dreq + 1 > rpd then return {0, 'requests', 'day', dreq, rpd} end
if rpm > 0 and mreq + 1 > rpm then return {0, 'requests', 'minute', mreq, rpm} end
if tpd > 0 and dtok + tokens > tpd then return {0, 'tokens', 'day', dtok, tpd} end
if tpm > 0 and mtok + tokens > tpm then return {0, 'tokens', 'minute', mtok, tpm} end
redis.call('HINCRBY', KEYS[1], 'req', 1)
redis.call('HINCRBY', KEYS[1], 'tok', tokens)
redis.call('PEXPIREAT', KEYS[1], ARGV[7])
redis.call('HINCRBY', KEYS[2], 'req', 1)
redis.call('HINCRBY', KEYS[2], 'tok', tokens)
redis.call('PEXPIREAT', KEYS[2], ARGV[8])
return {1}
`);

/** Adds a (possibly negative) token correction to both windows, never below zero. */
const CORRECT = new LuaScript(`
for i = 1, 2 do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    local tok = tonumber(redis.call('HGET', KEYS[i], 'tok') or '0') + tonumber(ARGV[1])
    if tok < 0 then tok = 0 end
    redis.call('HSET', KEYS[i], 'tok', tok)
  end
end
return 1
`);

/** Raises a window's count to at least `value` (the provider's own count from its headers). */
const RAISE = new LuaScript(`
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if tonumber(ARGV[2]) > current then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIREAT', KEYS[1], ARGV[3])
end
return 1
`);

export interface QuotaUsage {
  deployment: string;
  limits: QuotaLimits | null;
  minute: { requests: number; tokens: number };
  today: { requests: number; tokens: number };
  /** When the cooldown ends (ms since the epoch), or null when none is running. */
  cooldownUntil: number | null;
}

export interface QuotaBoardOptions {
  redis: Redis;
  clock: Clock;
  logger: Logger;
  /** Cooldown after an upstream 429 without a usable Retry-After; 0: none. */
  defaultCooldownMs: number;
  /** Key prefix; tests use their own. */
  prefix?: string;
  /** Told when a deployment is skipped, for metrics. */
  onSkip?: (deployment: string, kind: 'quota' | 'cooldown') => void;
  /** Told when a 429 starts a cooldown, for metrics. */
  onCooldown?: (deployment: string) => void;
}

/** What the board needs to know about a deployment. */
export interface QuotaTarget {
  id: string;
  quota: QuotaLimits | null;
}

const hasLimit = (q: QuotaLimits | null): q is QuotaLimits =>
  q !== null && Object.values(q).some((v) => v !== undefined && v > 0);

/**
 * Free-tier quotas and 429 cooldowns per deployment, shared by every gateway instance through
 * Redis (ADR 025). Counting uses Lua like the limiter (ADR 008), so instances never both take the
 * last request of a window. Every Redis failure fails open: the provider's own 429 still protects
 * the quota, and a free tier cannot overspend money.
 */
export class QuotaBoard {
  readonly #o: QuotaBoardOptions;
  readonly #prefix: string;

  constructor(options: QuotaBoardOptions) {
    this.#o = options;
    this.#prefix = options.prefix ?? 'gw:';
  }

  #keys(id: string, now: number) {
    const w = quotaWindows(now);
    return {
      minute: `${this.#prefix}quota:${id}:m:${w.minute}`,
      day: `${this.#prefix}quota:${id}:d:${w.day}`,
      cooldown: `${this.#prefix}cooldown:${id}`,
      windows: w,
    };
  }

  /**
   * May `target` be tried now? If so, counts one request and `tokens` against its quota (when it
   * has one). `ignoreCooldown` is for a retry on the same deployment after its own 429: the retry
   * already waited the provider's Retry-After (ADR 011).
   */
  async acquire(
    target: QuotaTarget,
    tokens: number,
    { ignoreCooldown = false }: { ignoreCooldown?: boolean } = {},
  ): Promise<QuotaCheck> {
    const now = this.#o.clock.now();
    const keys = this.#keys(target.id, now);
    const q = target.quota;
    const counted = hasLimit(q);
    let reply: unknown[];
    try {
      reply = (await this.#withTimeout(
        ACQUIRE.run(
          this.#o.redis,
          [keys.minute, keys.day, keys.cooldown],
          [
            q?.requestsPerMinute ?? 0,
            q?.requestsPerDay ?? 0,
            q?.tokensPerMinute ?? 0,
            q?.tokensPerDay ?? 0,
            counted ? 1 : 0,
            Math.max(0, Math.round(tokens)),
            keys.windows.minute + MINUTE_MS + GRACE_MS,
            keys.windows.day + DAY_MS + GRACE_MS,
            ignoreCooldown ? 1 : 0,
          ],
        ),
      )) as unknown[];
    } catch (err) {
      this.#o.logger.warn({ err, deployment: target.id }, 'quota check failed; trying anyway');
      return { ok: true, ticket: null };
    }
    if (reply[0] === 1) {
      return {
        ok: true,
        ticket: counted
          ? { minuteKey: keys.minute, dayKey: keys.day, tokens: Math.round(tokens) }
          : null,
      };
    }
    if (reply[1] === 'cooldown') {
      const ms = Number(reply[2]);
      this.#o.onSkip?.(target.id, 'cooldown');
      return {
        ok: false,
        kind: 'cooldown',
        reason: `cooldown after a 429, ${Math.ceil(ms / 1000)} s left`,
        retryAfterMs: ms,
      };
    }
    const unit = reply[1] as QuotaUnit;
    const window = reply[2] as QuotaWindow;
    this.#o.onSkip?.(target.id, 'quota');
    const retryAfterMs =
      window === 'day'
        ? untilWindowEnd(keys.windows.day, DAY_MS, now)
        : untilWindowEnd(keys.windows.minute, MINUTE_MS, now);
    return {
      ok: false,
      kind: 'quota',
      reason: describeSkip(unit, window, Number(reply[3]), Number(reply[4])),
      retryAfterMs,
    };
  }

  /**
   * Corrects the tokens counted for a try to what it used: the reported total, or the prompt
   * estimate when the provider reported nothing (the prompt was sent either way).
   */
  settle(ticket: QuotaTicket | null, usedTokens: number | null, promptEstimate: number): void {
    if (!ticket) return;
    const delta = Math.round((usedTokens ?? promptEstimate) - ticket.tokens);
    if (delta === 0) return;
    void this.#quietly('quota correction failed', () =>
      CORRECT.run(this.#o.redis, [ticket.minuteKey, ticket.dayKey], [delta]),
    );
  }

  /**
   * Puts a deployment on cooldown after an upstream 429, for its Retry-After or the default, so
   * every instance skips it until then. A longer cooldown already running is kept.
   */
  cooldown(id: string, retryAfterMs: number | undefined): void {
    const ms =
      retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : this.#o.defaultCooldownMs;
    if (ms <= 0) return;
    const key = `${this.#prefix}cooldown:${id}`;
    void this.#quietly('cooldown not stored', async () => {
      const current = await this.#o.redis.pttl(key);
      if (current < ms) {
        await this.#o.redis.set(key, '1', 'PX', Math.round(ms));
        this.#o.onCooldown?.(id);
      }
    });
  }

  /**
   * Raises the counts to the provider's own, from `x-ratelimit-*` headers whose limit matches a
   * configured quota (so the window is known): limit minus remaining is what the provider has
   * counted. Never lowers a count.
   */
  observe(target: QuotaTarget, headers: RateLimitHeaders | undefined): void {
    const q = target.quota;
    if (!headers || !hasLimit(q)) return;
    const now = this.#o.clock.now();
    const keys = this.#keys(target.id, now);
    const raises: [string, 'req' | 'tok', number, number][] = [];
    const { limitRequests, remainingRequests, limitTokens, remainingTokens } = headers;
    if (limitRequests !== undefined && remainingRequests !== undefined) {
      const used = limitRequests - remainingRequests;
      if (limitRequests === q.requestsPerDay) raises.push([keys.day, 'req', used, DAY_MS]);
      else if (limitRequests === q.requestsPerMinute)
        raises.push([keys.minute, 'req', used, MINUTE_MS]);
    }
    if (limitTokens !== undefined && remainingTokens !== undefined) {
      const used = limitTokens - remainingTokens;
      if (limitTokens === q.tokensPerMinute) raises.push([keys.minute, 'tok', used, MINUTE_MS]);
      else if (limitTokens === q.tokensPerDay) raises.push([keys.day, 'tok', used, DAY_MS]);
    }
    for (const [key, field, used, length] of raises) {
      if (used <= 0) continue;
      const start = length === DAY_MS ? keys.windows.day : keys.windows.minute;
      void this.#quietly('quota header correction failed', () =>
        RAISE.run(this.#o.redis, [key], [field, used, start + length + GRACE_MS]),
      );
    }
  }

  /** Each deployment's use in the current minute and day, and its cooldown, for the admin API. */
  async usage(targets: readonly QuotaTarget[]): Promise<QuotaUsage[]> {
    const now = this.#o.clock.now();
    const pipeline = this.#o.redis.pipeline();
    for (const t of targets) {
      const keys = this.#keys(t.id, now);
      pipeline.hmget(keys.minute, 'req', 'tok');
      pipeline.hmget(keys.day, 'req', 'tok');
      pipeline.pttl(keys.cooldown);
    }
    const replies = (await this.#withTimeout(pipeline.exec())) ?? [];
    const value = (i: number) => {
      const [err, result] = replies[i] ?? [null, null];
      if (err) throw err;
      return result;
    };
    const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
    return targets.map((t, i) => {
      const minute = value(i * 3) as (string | null)[];
      const day = value(i * 3 + 1) as (string | null)[];
      const ttl = Number(value(i * 3 + 2));
      return {
        deployment: t.id,
        limits: hasLimit(t.quota) ? t.quota : null,
        minute: { requests: num(minute[0]), tokens: num(minute[1]) },
        today: { requests: num(day[0]), tokens: num(day[1]) },
        cooldownUntil: ttl > 0 ? now + ttl : null,
      };
    });
  }

  async #withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('quota check timed out')), CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #quietly(message: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await this.#withTimeout(work());
    } catch (err) {
      this.#o.logger.warn({ err }, message);
    }
  }
}

/** The share of the tightest configured quota used (0..1+), for the quota gauge. */
export function quotaUsedShare(usage: QuotaUsage): number | null {
  const l = usage.limits;
  if (!l) return null;
  const shares = [
    l.requestsPerMinute ? usage.minute.requests / l.requestsPerMinute : 0,
    l.requestsPerDay ? usage.today.requests / l.requestsPerDay : 0,
    l.tokensPerMinute ? usage.minute.tokens / l.tokensPerMinute : 0,
    l.tokensPerDay ? usage.today.tokens / l.tokensPerDay : 0,
  ];
  return Math.max(...shares);
}
