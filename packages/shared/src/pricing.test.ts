import { describe, expect, it } from 'vitest';
import { costMicroUsd, priceAt } from './pricing.js';

describe('costMicroUsd', () => {
  it('prices input and output tokens separately, in micro-dollars', () => {
    // $0.15 / $0.60 per million tokens.
    const price = { inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000 };
    expect(costMicroUsd(1_000_000, 0, price)).toBe(150_000);
    expect(costMicroUsd(0, 1_000_000, price)).toBe(600_000);
    expect(costMicroUsd(1_000, 500, price)).toBe(450);
  });

  it('rounds a fraction of a micro-dollar up, and zero stays zero', () => {
    const price = { inputMicroUsdPerMTok: 150_000, outputMicroUsdPerMTok: 600_000 };
    expect(costMicroUsd(1, 0, price)).toBe(1);
    expect(costMicroUsd(0, 0, price)).toBe(0);
  });

  it('stays exact for large counts and prices', () => {
    const price = { inputMicroUsdPerMTok: 75_000_000, outputMicroUsdPerMTok: 150_000_000 };
    expect(costMicroUsd(2_000_000_000, 1_000_000_000, price)).toBe(300_000_000_000);
  });
});

describe('priceAt', () => {
  const versions = [
    { id: 'v1', effectiveFrom: 1_000 },
    { id: 'v3', effectiveFrom: 3_000 },
    { id: 'v2', effectiveFrom: 2_000 },
  ];

  it('picks the latest version not after the given time', () => {
    expect(priceAt(versions, 1_000)?.id).toBe('v1');
    expect(priceAt(versions, 2_999)?.id).toBe('v2');
    expect(priceAt(versions, 10_000)?.id).toBe('v3');
  });

  it('finds nothing before the first version', () => {
    expect(priceAt(versions, 999)).toBeUndefined();
  });
});
