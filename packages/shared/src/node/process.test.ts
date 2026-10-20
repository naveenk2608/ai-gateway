import type { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';
import { onShutdownSignal } from './process.js';

const EVENTS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];
type ProcessListener = (...args: unknown[]) => void;
// The plain EventEmitter view avoids process's per-event overloads.
const emitter: EventEmitter = process;

const silent = createLogger({
  name: 'test',
  level: 'silent',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe('onShutdownSignal', () => {
  let before: Map<string, ProcessListener[]>;

  beforeEach(() => {
    before = new Map(EVENTS.map((e) => [e, emitter.listeners(e) as ProcessListener[]]));
  });

  afterEach(() => {
    for (const event of EVENTS) {
      for (const listener of emitter.listeners(event) as ProcessListener[]) {
        if (!before.get(event)?.includes(listener)) emitter.removeListener(event, listener);
      }
    }
  });

  it('runs shutdown once and exits with the code it returns', async () => {
    const exit = vi.fn();
    const shutdown = vi.fn(() => Promise.resolve(0));
    onShutdownSignal(silent, shutdown, exit);

    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
  });

  it('exits immediately with code 1 on a second signal', () => {
    const exit = vi.fn();
    const shutdown = vi.fn(() => new Promise<number>(() => undefined));
    onShutdownSignal(silent, shutdown, exit);

    process.emit('SIGINT', 'SIGINT');
    expect(exit).not.toHaveBeenCalled();
    process.emit('SIGTERM', 'SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 when shutdown throws', async () => {
    const exit = vi.fn();
    onShutdownSignal(silent, () => Promise.reject(new Error('boom')), exit);

    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });
});
