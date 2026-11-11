import { describe, expect, it } from 'vitest';
import { SEED_PRICES, seedPricesLine } from './seed-prices.js';

describe('pnpm db:seed', () => {
  it('names the prices it seeds, and only those', () => {
    expect(SEED_PRICES.map((p) => `${p.provider}/${p.model}`)).toEqual([
      'mock/mock',
      'mock/mock-embed',
    ]);
    const line = seedPricesLine();
    expect(line).toBe(
      'Prices:   mock ($1.00 / $2.00 per million tokens), mock-embed ($0.10 per million input ' +
        "tokens), demo values for the mock provider; real providers' prices come from the migrations",
    );
    expect(line).not.toMatch(/groq|gemini/i);
  });
});
