import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 UUIDs', () => {
    expect(uuidv7()).toMatch(UUID_V7);
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 0, 123);
    const id = uuidv7(now);
    const encoded = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(encoded).toBe(now);
  });

  it('sorts by creation time across milliseconds', () => {
    const ids = [3, 1, 2].map((offset) => uuidv7(1_700_000_000_000 + offset));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
  });

  it('is unique within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(1_700_000_000_000)));
    expect(ids.size).toBe(1000);
  });

  it('rejects timestamps outside 48 bits', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
  });
});
