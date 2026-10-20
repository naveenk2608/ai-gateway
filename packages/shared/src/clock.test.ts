import { describe, expect, it } from 'vitest';
import { abortReason, ManualClock, systemClock } from './clock.js';

describe('systemClock', () => {
  it('resolves a sleep after the delay', async () => {
    const start = Date.now();
    await systemClock.sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });

  it('rejects a sleep with the abort reason', async () => {
    const controller = new AbortController();
    const sleeping = systemClock.sleep(10_000, controller.signal);
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const reason = new Error('already');
    await expect(systemClock.sleep(10_000, AbortSignal.abort(reason))).rejects.toBe(reason);
  });
});

describe('abortReason', () => {
  it('returns an Error reason as is and wraps anything else', () => {
    const reason = new Error('stop');
    expect(abortReason(AbortSignal.abort(reason))).toBe(reason);
    const wrapped = abortReason(AbortSignal.abort('just a string'));
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.cause).toBe('just a string');
  });
});

describe('ManualClock', () => {
  it('only moves when advanced', async () => {
    const clock = new ManualClock(1_000);
    expect(clock.now()).toBe(1_000);
    await clock.advance(250);
    expect(clock.now()).toBe(1_250);
  });

  it('wakes sleepers in time order, at their due time', async () => {
    const clock = new ManualClock(0);
    const woke: string[] = [];
    void clock.sleep(30).then(() => woke.push(`b@${clock.now()}`));
    void clock.sleep(10).then(() => woke.push(`a@${clock.now()}`));
    void clock.sleep(100).then(() => woke.push(`c@${clock.now()}`));

    await clock.advance(50);
    expect(woke).toEqual(['a@10', 'b@30']);
    expect(clock.pendingSleeps).toBe(1);
    expect(clock.now()).toBe(50);
  });

  it('runs chained sleeps scheduled while advancing', async () => {
    const clock = new ManualClock(0);
    const ticks: number[] = [];
    const loop = (async () => {
      for (let i = 0; i < 3; i++) {
        await clock.sleep(10);
        ticks.push(clock.now());
      }
    })();
    await clock.advance(100);
    await loop;
    expect(ticks).toEqual([10, 20, 30]);
  });

  it('rejects an aborted sleep and forgets it', async () => {
    const clock = new ManualClock(0);
    const controller = new AbortController();
    const sleeping = clock.sleep(10, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(sleeping).rejects.toThrow('cancelled');
    expect(clock.pendingSleeps).toBe(0);
  });
});
