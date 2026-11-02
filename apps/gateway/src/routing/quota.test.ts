import { describe, expect, it } from 'vitest';
import { describeSkip, quotaUsedShare, quotaWindows, untilWindowEnd } from './quota.js';

const at = (iso: string) => Date.parse(iso);

describe('quota windows', () => {
  it('counts in fixed UTC minutes and days', () => {
    expect(quotaWindows(at('2026-11-03T13:45:30.250Z'))).toEqual({
      minute: at('2026-11-03T13:45:00Z'),
      day: at('2026-11-03T00:00:00Z'),
    });
  });

  it('starts a new window exactly on the boundary', () => {
    expect(quotaWindows(at('2026-11-04T00:00:00Z'))).toEqual({
      minute: at('2026-11-04T00:00:00Z'),
      day: at('2026-11-04T00:00:00Z'),
    });
    expect(quotaWindows(at('2026-11-03T23:59:59.999Z'))).toEqual({
      minute: at('2026-11-03T23:59:00Z'),
      day: at('2026-11-03T00:00:00Z'),
    });
  });

  it('waits until the window ends, at least a millisecond', () => {
    const now = at('2026-11-03T23:59:30Z');
    const { minute, day } = quotaWindows(now);
    expect(untilWindowEnd(minute, 60_000, now)).toBe(30_000);
    expect(untilWindowEnd(day, 86_400_000, now)).toBe(30_000);
    expect(untilWindowEnd(minute, 60_000, minute + 60_000)).toBe(1);
  });
});

describe('describeSkip', () => {
  it('says which quota is used up, as stored on the next attempt', () => {
    expect(describeSkip('requests', 'day', 1000, 1000)).toBe(
      'quota, 1,000 of 1,000 requests today',
    );
    expect(describeSkip('tokens', 'minute', 7900, 8000)).toBe(
      'quota, 7,900 of 8,000 tokens this minute',
    );
  });
});

describe('quotaUsedShare', () => {
  const usage = (limits: Parameters<typeof quotaUsedShare>[0]['limits']) => ({
    deployment: 'd',
    limits,
    minute: { requests: 15, tokens: 2_000 },
    today: { requests: 250, tokens: 50_000 },
    cooldownUntil: null,
  });

  it('is the share of the tightest quota', () => {
    expect(
      quotaUsedShare(
        usage({ requestsPerMinute: 30, requestsPerDay: 1_000, tokensPerMinute: 8_000 }),
      ),
    ).toBe(0.5);
    expect(quotaUsedShare(usage({ tokensPerDay: 200_000 }))).toBe(0.25);
  });

  it('is null without a quota', () => {
    expect(quotaUsedShare(usage(null))).toBeNull();
  });
});
