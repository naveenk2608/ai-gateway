import { createHash } from 'node:crypto';
import type { Redis } from '@ai-gateway/shared/node';

/**
 * A Lua script run with EVALSHA, loaded with EVAL the first time a server has not seen it (after
 * a restart, for instance). Scripts run atomically, which is what makes the limits hold across
 * gateway instances (ADR 008).
 */
export class LuaScript {
  readonly sha: string;
  readonly #source: string;

  constructor(source: string) {
    this.#source = source;
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  async run(redis: Redis, keys: readonly string[], args: readonly (string | number)[]) {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('NOSCRIPT'))) throw err;
      return redis.eval(this.#source, keys.length, ...keys, ...args);
    }
  }
}

/**
 * Token bucket refill shared by the scripts: `cap` tokens per minute, never above `cap`. A bucket
 * last written by an instance whose clock runs ahead (ts > now) is not refilled until time catches
 * up, and `ts` never moves backwards.
 */
const BUCKET = `
local function bucket(key, cap, now)
  local state = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(state[1])
  local ts = tonumber(state[2])
  if tokens == nil or ts == nil then return cap, now end
  if now > ts then
    tokens = math.min(cap, tokens + (now - ts) * cap / 60000)
    ts = now
  end
  return tokens, ts
end
`;

/**
 * Checks every limit of a request and, only if all pass, takes them all.
 *
 * KEYS: 1-2 RPM buckets (key, project), 3-4 TPM buckets, 5-6 concurrency lease sets,
 *       7 budget totals, 8 budget reservations, 9 index of open reservations.
 * ARGV: 1 now, 2-3 RPM limits, 4-5 TPM limits, 6 tokens to reserve, 7-8 concurrency limits,
 *       9 lease and reservation id, 10 lease expiry, 11 budget limit (-1: none), 12 amount to
 *       reserve, 13 member in the open index, 14 budget key TTL, 15 budget period end,
 *       16 lease set TTL. A limit of 0 skips that check.
 * Returns {1} when admitted, {-1} when the budget totals are missing (to be rebuilt from Postgres),
 * or {0, reason, scope, retryAfterMs} (retryAfterMs -1: the request can never fit).
 */
export const ADMIT = new LuaScript(`${BUCKET}
local now = tonumber(ARGV[1])
local scopes = {'key', 'project'}
local rpm = {tonumber(ARGV[2]), tonumber(ARGV[3])}
local tpm = {tonumber(ARGV[4]), tonumber(ARGV[5])}
local need = tonumber(ARGV[6])
local conc = {tonumber(ARGV[7]), tonumber(ARGV[8])}
local rpmState, tpmState = {}, {}

for i = 1, 2 do
  if rpm[i] > 0 then
    local tokens, ts = bucket(KEYS[i], rpm[i], now)
    if tokens < 1 then
      return {0, 'rpm', scopes[i], math.ceil((1 - tokens) * 60000 / rpm[i])}
    end
    rpmState[i] = {tokens, ts}
  end
end
for i = 1, 2 do
  if tpm[i] > 0 then
    if need > tpm[i] then return {0, 'tpm', scopes[i], -1} end
    local tokens, ts = bucket(KEYS[2 + i], tpm[i], now)
    if tokens < need then
      return {0, 'tpm', scopes[i], math.ceil((need - tokens) * 60000 / tpm[i])}
    end
    tpmState[i] = {tokens, ts}
  end
end
for i = 1, 2 do
  if conc[i] > 0 then
    redis.call('ZREMRANGEBYSCORE', KEYS[4 + i], '-inf', now)
    if redis.call('ZCARD', KEYS[4 + i]) >= conc[i] then
      return {0, 'concurrency', scopes[i], 1000}
    end
  end
end
local budgetLimit = tonumber(ARGV[11])
local amount = tonumber(ARGV[12])
if budgetLimit >= 0 then
  if redis.call('EXISTS', KEYS[7]) == 0 then return {-1} end
  local totals = redis.call('HMGET', KEYS[7], 'spent', 'reserved')
  local spent = tonumber(totals[1]) or 0
  local reserved = tonumber(totals[2]) or 0
  if amount > budgetLimit then return {0, 'budget', 'project', -1} end
  if spent + reserved + amount > budgetLimit then
    return {0, 'budget', 'project', math.max(1000, tonumber(ARGV[15]) - now)}
  end
end

for i = 1, 2 do
  if rpm[i] > 0 then
    redis.call('HSET', KEYS[i], 'tokens', rpmState[i][1] - 1, 'ts', rpmState[i][2])
    redis.call('PEXPIRE', KEYS[i], 120000)
  end
  if tpm[i] > 0 then
    redis.call('HSET', KEYS[2 + i], 'tokens', tpmState[i][1] - need, 'ts', tpmState[i][2])
    redis.call('PEXPIRE', KEYS[2 + i], 120000)
  end
  if conc[i] > 0 then
    redis.call('ZADD', KEYS[4 + i], ARGV[10], ARGV[9])
    redis.call('PEXPIRE', KEYS[4 + i], ARGV[16])
  end
end
if budgetLimit >= 0 and amount > 0 then
  redis.call('HINCRBY', KEYS[7], 'reserved', ARGV[12])
  redis.call('HSET', KEYS[8], ARGV[9], ARGV[12])
  redis.call('PEXPIRE', KEYS[8], ARGV[14])
  redis.call('ZADD', KEYS[9], ARGV[10], ARGV[13])
end
return {1}
`);

/**
 * Creates the budget totals from the spend Postgres recorded, unless another instance did first.
 * KEYS: 1 budget totals. ARGV: 1 spent, 2 TTL. Returns 1 if this call created them.
 */
export const INIT_BUDGET = new LuaScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'spent', ARGV[1], 'reserved', 0)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`);

/**
 * Ends a request: returns unused tokens to the TPM buckets (or takes the overshoot), frees the
 * concurrency leases, releases the budget reservation and charges the actual cost.
 *
 * KEYS: 1-2 TPM buckets, 3-4 concurrency lease sets, 5 budget totals, 6 budget reservations,
 *       7 index of open reservations.
 * ARGV: 1 now, 2-3 TPM limits, 4 tokens reserved, 5 tokens used, 6 lease id, 7 actual cost,
 *       8 member in the open index, 9 '1' if a budget applies.
 * Returns 1 if the cost was charged to the budget totals, 0 if they were missing (Redis lost them;
 * Postgres still records the cost and the next rebuild includes it).
 */
export const SETTLE = new LuaScript(`${BUCKET}
local now = tonumber(ARGV[1])
local delta = tonumber(ARGV[4]) - tonumber(ARGV[5])
for i = 1, 2 do
  local cap = tonumber(ARGV[1 + i])
  if cap > 0 and delta ~= 0 then
    local tokens, ts = bucket(KEYS[i], cap, now)
    redis.call('HSET', KEYS[i], 'tokens', math.min(cap, tokens + delta), 'ts', ts)
    redis.call('PEXPIRE', KEYS[i], 120000)
  end
  redis.call('ZREM', KEYS[2 + i], ARGV[6])
end
redis.call('ZREM', KEYS[7], ARGV[8])
if ARGV[9] ~= '1' or redis.call('EXISTS', KEYS[5]) == 0 then return 0 end
local held = redis.call('HGET', KEYS[6], ARGV[6])
if held then
  redis.call('HDEL', KEYS[6], ARGV[6])
  redis.call('HINCRBY', KEYS[5], 'reserved', -tonumber(held))
end
redis.call('HINCRBY', KEYS[5], 'spent', ARGV[7])
return 1
`);

/**
 * Extends a running request's leases and budget reservation, so only a request that stopped
 * renewing (its instance crashed) loses them.
 * KEYS: 1-2 concurrency lease sets, 3 index of open reservations.
 * ARGV: 1 lease id, 2 new expiry, 3 member in the open index, 4 lease set TTL.
 */
export const RENEW = new LuaScript(`
for i = 1, 2 do
  if redis.call('ZADD', KEYS[i], 'XX', 'CH', ARGV[2], ARGV[1]) == 1 then
    redis.call('PEXPIRE', KEYS[i], ARGV[4])
  end
end
redis.call('ZADD', KEYS[3], 'XX', ARGV[2], ARGV[3])
return 1
`);

/**
 * Releases budget reservations whose request stopped renewing them (ADR 009). Members of the
 * open index are `projectId|period|requestId`.
 * KEYS: 1 index of open reservations. ARGV: 1 now, 2 most to release, 3 budget key prefix.
 * Returns a flat list: member, amount, member, amount, ...
 */
export const SWEEP = new LuaScript(`
local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local expired = {}
for _, member in ipairs(members) do
  redis.call('ZREM', KEYS[1], member)
  local project, period, request = string.match(member, '^([^|]+)|([^|]+)|([^|]+)$')
  if project then
    local totals = ARGV[3] .. project .. ':' .. period
    local held = redis.call('HGET', totals .. ':res', request)
    if held and redis.call('EXISTS', totals) == 1 then
      redis.call('HDEL', totals .. ':res', request)
      redis.call('HINCRBY', totals, 'reserved', -tonumber(held))
      table.insert(expired, member)
      table.insert(expired, held)
    end
  end
end
return expired
`);

/**
 * Takes one token from a bucket of `cap` per minute, for simple rate limits (admin logins).
 * KEYS: 1 bucket. ARGV: 1 now, 2 cap. Returns {1} or {0, retryAfterMs}.
 */
export const TAKE = new LuaScript(`${BUCKET}
local now = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local tokens, ts = bucket(KEYS[1], cap, now)
if tokens < 1 then return {0, math.ceil((1 - tokens) * 60000 / cap)} end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'ts', ts)
redis.call('PEXPIRE', KEYS[1], 120000)
return {1}
`);
