// Computes vectors for every text in pairs.json through a running gateway's /v1/embeddings, so the
// false-hit measurement can be repeated with another embeddings model (M18, ADR 040):
//
//   GATEWAY_URL=http://localhost:8080 GATEWAY_API_KEY=gw_... \
//     pnpm tsx bench/semantic/embed.ts gemini-embedding-001 bench/semantic/vectors-gemini.json
//   pnpm bench:semantic --vectors bench/semantic/vectors-gemini.json
//
// The key is read from the environment and never printed. One text per request, in order.
import { writeFileSync } from 'node:fs';
import { loadPairs } from './measure.js';

const [model, out] = process.argv.slice(2);
const base = process.env.GATEWAY_URL;
const key = process.env.GATEWAY_API_KEY;
if (!model || !out || !base || !key) {
  process.stderr.write(
    'usage: GATEWAY_URL=... GATEWAY_API_KEY=... tsx bench/semantic/embed.ts <model> <out.json>\n',
  );
  process.exit(2);
}

/** The one vector of an OpenAI-format embeddings answer. */
function vectorOf(body: unknown): number[] {
  const data = (body as { data?: { embedding?: unknown }[] }).data;
  const vector = data?.length === 1 ? data[0]?.embedding : undefined;
  if (!Array.isArray(vector) || !vector.every((x) => typeof x === 'number')) {
    throw new Error('the gateway sent no single vector of numbers');
  }
  return vector;
}
const texts = [
  ...new Set(
    loadPairs().flatMap((g) => [g.anchor, ...(g.surface ?? []), ...g.match, ...g.distinct]),
  ),
];
const vectors: Record<string, string> = {};
let dimensions = 0;
for (const text of texts) {
  const res = await fetch(`${base.replace(/\/$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: [text] }),
  });
  if (!res.ok)
    throw new Error(`the gateway answered ${res.status} for text ${texts.indexOf(text)}`);
  const vector = vectorOf(await res.json());
  dimensions = vector.length;
  vectors[text] = Buffer.from(new Float32Array(vector).buffer).toString('base64');
}
writeFileSync(
  out,
  `${JSON.stringify(
    {
      about: `Vectors of every text in pairs.json through the gateway's /v1/embeddings.`,
      model,
      revision: null,
      runtime: `gateway /v1/embeddings, model ${model}`,
      matchesDeployment: model,
      computedAt: new Date().toISOString().slice(0, 10),
      dimensions,
      vectors,
    },
    null,
    1,
  )}\n`,
);
process.stdout.write(`wrote ${texts.length} vectors of ${dimensions} numbers to ${out}\n`);
