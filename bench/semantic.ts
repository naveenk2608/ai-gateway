// The semantic cache's hit and false-hit rates per threshold (M18, ADR 040), from the committed
// labelled pairs and vectors. Run with `pnpm bench:semantic`: it prints the table and writes
// bench/semantic/results.json and results.md, which a CI test recomputes and compares.
// `pnpm bench:semantic --vectors <file>` measures other vectors (bench/semantic/embed.ts makes
// them through a gateway) and only prints the table.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPairs, loadVectors, measure, renderMarkdown } from './semantic/measure.js';

const out = (name: string) => fileURLToPath(new URL(`./semantic/${name}`, import.meta.url));
const flag = process.argv.indexOf('--vectors');
const other = flag === -1 ? undefined : process.argv[flag + 1];

const results = measure(loadPairs(), loadVectors(other));
const markdown = renderMarkdown(results);
if (other === undefined) {
  writeFileSync(out('results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(out('results.md'), markdown);
}
process.stdout.write(markdown);
