import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { CircuitBreaker, countsAsFailure, type Transition } from './breaker.js';

function breaker() {
  const clock = new ManualClock(0);
  const transitions: Transition[] = [];
  const b = new CircuitBreaker('primary', { failureThreshold: 3, openMs: 10_000 }, clock, (t) =>
    transitions.push(t),
  );
  const moves = () => transitions.map((t) => `${t.from}->${t.to}: ${t.reason}`);
  return { clock, b, moves };
}

describe('CircuitBreaker', () => {
  it('opens after the threshold of consecutive failures; a success resets the count', () => {
    const { b, moves } = breaker();
    b.onFailure('server_error');
    b.onFailure('server_error');
    b.onSuccess();
    b.onFailure('timeout');
    b.onFailure('timeout');
    expect(b.state).toBe('closed');
    b.onFailure('server_error');
    expect(b.state).toBe('open');
    expect(b.tryAcquire()).toBe(false);
    expect(moves()).toEqual(['closed->open: 3 consecutive failures (last: server_error)']);
  });

  it('half-opens after the wait and admits one trial at a time', async () => {
    const { clock, b } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure('connection');
    expect(b.retryInMs).toBe(10_000);
    await clock.advance(9_999);
    expect(b.state).toBe('open');
    await clock.advance(1);
    expect(b.state).toBe('half_open');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
  });

  it('closes when the trial succeeds and reopens when it fails', async () => {
    const { clock, b, moves } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure('connection');
    await clock.advance(10_000);
    b.tryAcquire();
    b.onFailure('timeout');
    expect(b.state).toBe('open');
    await clock.advance(10_000);
    b.tryAcquire();
    b.onSuccess();
    expect(b.state).toBe('closed');
    expect(moves()).toEqual([
      'closed->open: 3 consecutive failures (last: connection)',
      'open->half_open: no trial for 10000 ms',
      'half_open->open: trial request failed (timeout)',
      'open->half_open: no trial for 10000 ms',
      'half_open->closed: trial request succeeded',
    ]);
  });

  it('half-opens as soon as a health check passes', () => {
    const { b, moves } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure('server_error');
    b.probeSucceeded();
    expect(b.state).toBe('half_open');
    expect(moves().at(-1)).toBe('open->half_open: health check passed');
  });

  it('frees the trial slot when the trial ends without a verdict', async () => {
    const { clock, b } = breaker();
    for (let i = 0; i < 3; i++) b.onFailure('server_error');
    await clock.advance(10_000);
    expect(b.tryAcquire()).toBe(true);
    b.onNeutral();
    expect(b.state).toBe('half_open');
    expect(b.tryAcquire()).toBe(true);
  });

  it('ignores errors that say nothing about the deployment', () => {
    expect(countsAsFailure('bad_request')).toBe(false);
    expect(countsAsFailure('canceled')).toBe(false);
    expect(countsAsFailure('rate_limited')).toBe(true);
  });
});
