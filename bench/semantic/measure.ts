// The semantic cache's hit and false-hit rates per threshold (M18, ADR 040), from the labelled
// pairs in pairs.json and the vectors computed once for their texts in vectors.json. Each pair is
// a stored request (the group's anchor) and a new one: it is answered from the stored one when
// their cosine similarity is at or above the threshold, as the gateway decides.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export interface Group {
  anchor: string;
  /** The same question with other casing, spacing, punctuation or spelling. */
  surface?: string[];
  /** Paraphrases: the same question in other words. */
  match: string[];
  /** Near misses: alike, but needing another answer. */
  distinct: string[];
}

export interface Vectors {
  model: string;
  revision: string | null;
  runtime: string;
  matchesDeployment: string;
  computedAt: string;
  dimensions: number;
  /** Base64 of little-endian float32, per text. */
  vectors: Record<string, string>;
}

export function loadPairs(path = here('./pairs.json')): Group[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { groups: Group[] }).groups;
}

export function loadVectors(path = here('./vectors.json')): Vectors {
  return JSON.parse(readFileSync(path, 'utf8')) as Vectors;
}

function decode(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity, as pgvector's `1 - (a <=> b)` gives it. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / Math.sqrt(na * nb);
}

export type PairKind = 'surface' | 'paraphrase' | 'near_miss';

export interface Pair {
  stored: string;
  asked: string;
  kind: PairKind;
  similarity: number;
}

/** Every labelled pair with its similarity; a text without a vector is an error. */
export function pairSimilarities(groups: Group[], vectors: Vectors): Pair[] {
  const vector = (text: string) => {
    const v = vectors.vectors[text];
    if (v === undefined) throw new Error(`no vector for: ${text}`);
    return decode(v);
  };
  return groups.flatMap((g) => {
    const anchor = vector(g.anchor);
    const pair = (asked: string, kind: PairKind): Pair => ({
      stored: g.anchor,
      asked,
      kind,
      similarity: cosine(anchor, vector(asked)),
    });
    return [
      ...(g.surface ?? []).map((t) => pair(t, 'surface')),
      ...g.match.map((t) => pair(t, 'paraphrase')),
      ...g.distinct.map((t) => pair(t, 'near_miss')),
    ];
  });
}

/** Thresholds measured, in thousandths: 0.80 to 0.99 in steps of 0.01, then 0.995 and 0.999. */
export const THRESHOLDS_MILLI = [...Array.from({ length: 20 }, (_, i) => 800 + i * 10), 995, 999];

export interface Row {
  threshold: number;
  surface: { answered: number; of: number };
  paraphrase: { answered: number; of: number };
  /** Surface variants and paraphrases answered: the hits a cache should make. */
  hitRate: number;
  nearMiss: { answered: number; of: number };
  /** Near misses answered from the stored request: wrong answers. */
  falseHitRate: number;
}

export interface Results {
  model: string;
  revision: string | null;
  runtime: string;
  matchesDeployment: string;
  computedAt: string;
  pairs: { surface: number; paraphrase: number; nearMiss: number };
  rows: Row[];
  /** The lowest threshold measured at which no near miss is answered; null if none is. */
  defaultThreshold: number | null;
  /** The pair kinds' similarity ranges, rounded to four decimals. */
  ranges: Record<PairKind, { min: number; max: number }>;
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

export function measure(groups: Group[], vectors: Vectors): Results {
  const pairs = pairSimilarities(groups, vectors);
  const of = (kind: PairKind) => pairs.filter((p) => p.kind === kind);
  const count = (kind: PairKind, t: number) => of(kind).filter((p) => p.similarity >= t).length;
  const rows = THRESHOLDS_MILLI.map((milli): Row => {
    const t = milli / 1000;
    const surface = { answered: count('surface', t), of: of('surface').length };
    const paraphrase = { answered: count('paraphrase', t), of: of('paraphrase').length };
    const nearMiss = { answered: count('near_miss', t), of: of('near_miss').length };
    return {
      threshold: t,
      surface,
      paraphrase,
      hitRate: round((surface.answered + paraphrase.answered) / (surface.of + paraphrase.of), 6),
      nearMiss,
      falseHitRate: round(nearMiss.answered / nearMiss.of, 6),
    };
  });
  const range = (kind: PairKind) => {
    const s = of(kind).map((p) => p.similarity);
    return { min: round(Math.min(...s), 4), max: round(Math.max(...s), 4) };
  };
  return {
    model: vectors.model,
    revision: vectors.revision,
    runtime: vectors.runtime,
    matchesDeployment: vectors.matchesDeployment,
    computedAt: vectors.computedAt,
    pairs: {
      surface: of('surface').length,
      paraphrase: of('paraphrase').length,
      nearMiss: of('near_miss').length,
    },
    rows,
    defaultThreshold: rows.find((r) => r.nearMiss.answered === 0)?.threshold ?? null,
    ranges: {
      surface: range('surface'),
      paraphrase: range('paraphrase'),
      near_miss: range('near_miss'),
    },
  };
}

const pct = (n: number) => `${round(n * 100, 1)}%`;
/** 0.80, 0.81, ..., 0.995: two decimals unless the threshold needs three. */
const fixed = (t: number) => t.toFixed(Math.round(t * 1000) % 10 === 0 ? 2 : 3);
const share = (s: { answered: number; of: number }) =>
  `${s.answered}/${s.of} (${pct(s.of === 0 ? 0 : s.answered / s.of)})`;

/** The README's sentence on the default: generated, so it can only state measured numbers. */
export function summaryLine(r: Results): string {
  const row = r.rows.find((x) => x.threshold === r.defaultThreshold);
  if (!row) return 'No threshold measured keeps every near miss out.';
  return (
    `At the default threshold of ${fixed(row.threshold)}, the false-hit rate on the labelled set is ` +
    `${pct(row.falseHitRate)} (${row.nearMiss.answered} of ${row.nearMiss.of} near misses ` +
    `answered) and the hit rate is ${pct(row.hitRate)} (${share(row.surface)} surface variants, ` +
    `${share(row.paraphrase)} paraphrases).`
  );
}

/** results.md: the table, written by `pnpm bench:semantic`. */
export function renderMarkdown(r: Results): string {
  const lines = [
    '# Semantic cache: hit and false-hit rates per threshold',
    '',
    'Generated by `pnpm bench:semantic` from `bench/semantic/pairs.json` (labelled by hand) and',
    '`bench/semantic/vectors.json`; do not edit by hand. See ADR 040.',
    '',
    `- Vectors: \`${r.model}\` (revision \`${r.revision ?? 'unknown'}\`), ${r.runtime}; ` +
      `computed ${r.computedAt}. Same model as ${r.matchesDeployment}.`,
    `- Pairs: ${r.pairs.surface} surface variants and ${r.pairs.paraphrase} paraphrases that ` +
      `should be answered from the stored request, ${r.pairs.nearMiss} near misses that must not.`,
    `- Similarity ranges: surface variants ${r.ranges.surface.min} to ${r.ranges.surface.max}, ` +
      `paraphrases ${r.ranges.paraphrase.min} to ${r.ranges.paraphrase.max}, near misses ` +
      `${r.ranges.near_miss.min} to ${r.ranges.near_miss.max}.`,
    `- Default threshold (the lowest measured that answers no near miss): ` +
      `${r.defaultThreshold === null ? 'none' : fixed(r.defaultThreshold)}. ${summaryLine(r)}`,
    '',
    '| Threshold | Surface variants answered | Paraphrases answered | Hit rate | Near misses answered | False-hit rate |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.rows.map(
      (row) =>
        `| ${fixed(row.threshold)} | ${share(row.surface)} | ${share(row.paraphrase)} | ` +
        `${pct(row.hitRate)} | ${share(row.nearMiss)} | ${pct(row.falseHitRate)} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
