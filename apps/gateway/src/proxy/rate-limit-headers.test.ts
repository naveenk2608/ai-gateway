import { describe, expect, it } from 'vitest';
import { rateLimitState } from '../limits/limiter.js';
import { UNLIMITED, type UsagePolicy } from '../limits/policy.js';
import { formatReset } from './rate-limit-headers.js';

describe('formatReset', () => {
  it.each([
    [0, '0ms'],
    [120, '120ms'],
    [999.2, '1s'],
    [1000, '1s'],
    [1500, '1.5s'],
    [12_000, '12s'],
    [23_997, '23.997s'],
    [60_000, '1m0s'],
    [360_000, '6m0s'],
    [90_500, '1m30.5s'],
    [3_723_000, '1h2m3s'],
  ])('%d ms is %s, as OpenAI writes it', (ms, text) => {
    expect(formatReset(ms)).toBe(text);
  });
});

describe('rateLimitState', () => {
  const policy = (key: Partial<UsagePolicy['key']>, project: Partial<UsagePolicy['project']>) => ({
    ...UNLIMITED,
    key: { ...UNLIMITED.key, ...key },
    project: { ...UNLIMITED.project, ...project },
  });
  // An admitted ADMIT reply: 1, spent, reserved, then left and ms-until-full per bucket, in the
  // order RPM key, RPM project, TPM key, TPM project.
  const reply = [1, 0, 0, 4, 12_000, 90, 6_000, -1, -1, 9_000, 6_000];

  it('takes the bucket with the least left, key or project', () => {
    const state = rateLimitState(reply, policy({ rpm: 5 }, { rpm: 100, tpm: 10_000 }));
    expect(state).toEqual({
      requests: { limit: 5, remaining: 4, resetMs: 12_000 },
      tokens: { limit: 10_000, remaining: 9_000, resetMs: 6_000 },
    });
  });

  it('on a tie, the smaller limit', () => {
    const tie = [1, 0, 0, 3, 36_000, 3, 1_800, -1, -1, -1, -1];
    expect(rateLimitState(tie, policy({ rpm: 5 }, { rpm: 100 })).requests?.limit).toBe(5);
  });

  it('leaves out a kind with no limit', () => {
    const none = [1, 0, 0, -1, -1, -1, -1, -1, -1, -1, -1];
    expect(rateLimitState(none, UNLIMITED)).toEqual({});
  });
});
