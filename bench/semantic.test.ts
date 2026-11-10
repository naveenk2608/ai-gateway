import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SEMANTIC_THRESHOLD } from '../apps/gateway/src/semantic/policy.js';
import {
  cosine,
  loadPairs,
  loadVectors,
  measure,
  pairSimilarities,
  renderMarkdown,
  summaryLine,
} from './semantic/measure.js';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/**
 * The semantic cache's false-hit measurement (M18, ADR 040): recomputed from the committed
 * vectors, so the published table, the README's sentence and the gateway's default threshold can
 * only state what the vectors give.
 */
describe('semantic cache hit and false-hit rates', () => {
  const groups = loadPairs();
  const vectors = loadVectors();
  const results = measure(groups, vectors);

  it('has a vector of the stated size for every labelled text', () => {
    const pairs = pairSimilarities(groups, vectors);
    expect(pairs.length).toBe(
      results.pairs.surface + results.pairs.paraphrase + results.pairs.nearMiss,
    );
    for (const p of pairs) expect(Number.isFinite(p.similarity)).toBe(true);
    const first = Buffer.from(Object.values(vectors.vectors)[0]!, 'base64');
    expect(first.length / 4).toBe(vectors.dimensions);
    // Every near miss of the kilometres group is a separate question, not a paraphrase.
    expect(groups[0]!.distinct).toContain('Convert 10 miles to kilometres.');
  });

  it('matches the committed results and table, as `pnpm bench:semantic` wrote them', () => {
    expect(JSON.parse(read('./semantic/results.json'))).toEqual(results);
    expect(read('./semantic/results.md')).toBe(renderMarkdown(results));
  });

  it("is the gateway's default threshold, at which no near miss is answered", () => {
    expect(results.defaultThreshold).toBe(DEFAULT_SEMANTIC_THRESHOLD);
    const row = results.rows.find((r) => r.threshold === DEFAULT_SEMANTIC_THRESHOLD)!;
    expect(row.nearMiss.answered).toBe(0);
    expect(row.falseHitRate).toBe(0);
    // Every lower threshold measured answers at least one near miss.
    for (const lower of results.rows.filter((r) => r.threshold < DEFAULT_SEMANTIC_THRESHOLD)) {
      expect(lower.nearMiss.answered).toBeGreaterThan(0);
    }
  });

  it('is published in the README as measured', () => {
    expect(read('../README.md')).toContain(summaryLine(results));
  });

  it('cosine is the similarity pgvector gives', () => {
    const a = new Float32Array([1, 0, 0]);
    expect(cosine(a, new Float32Array([2, 0, 0]))).toBeCloseTo(1, 10);
    expect(cosine(a, new Float32Array([0, 3, 0]))).toBeCloseTo(0, 10);
    expect(cosine(a, new Float32Array([0.96, 0.28, 0]))).toBeCloseTo(0.96, 6);
  });
});
