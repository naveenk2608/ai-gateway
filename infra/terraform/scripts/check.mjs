// Static checks on the Terraform code, using the AWS provider's own schema:
//   - every resource whose type supports `tags` sets them from the shared tag map
//     (`local.tags` in the setups, `var.tags` in modules);
//   - no NAT gateway anywhere, and no load balancer in the demo.
//
// Usage: terraform -chdir=infra/terraform/full providers schema -json > schema.json
//        node infra/terraform/scripts/check.mjs schema.json
// Node built-ins only, so CI can run it without installing anything.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = {
  everywhere: ['aws_nat_gateway'],
  demo: ['aws_lb', 'aws_alb', 'aws_elb'],
};

const schemaPath = process.argv[2];
if (!schemaPath) {
  console.error('usage: node check.mjs <providers-schema.json>');
  process.exit(2);
}
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const taggable = new Set();
for (const provider of Object.values(schema.provider_schemas ?? {})) {
  for (const [type, s] of Object.entries(provider.resource_schemas ?? {})) {
    if (s.block?.attributes?.tags) taggable.add(type);
  }
}
if (!taggable.has('aws_instance')) {
  console.error('The schema has no AWS resources; run `providers schema -json` after init.');
  process.exit(2);
}

/** .tf files under infra/terraform, outside .terraform and tests. */
function tfFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith('.') || entry.name === 'tests' ? [] : tfFiles(path);
    }
    return entry.name.endsWith('.tf') ? [path] : [];
  });
}

/**
 * The resource blocks of an HCL file with their top-level argument names. Strings, comments and
 * heredocs are skipped so braces inside them do not count.
 */
function resources(text) {
  const found = [];
  let depth = 0;
  let current = null;
  let i = 0;
  let lineStart = true;
  const at = (s) => text.startsWith(s, i);
  while (i < text.length) {
    const c = text[i];
    if (lineStart) {
      lineStart = false;
      const line = text.slice(i, text.indexOf('\n', i) === -1 ? undefined : text.indexOf('\n', i));
      if (depth === 0) {
        const m = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/.exec(line);
        if (m) current = { type: m[1], name: m[2], args: new Map() };
      } else if (depth === 1 && current) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (m) current.args.set(m[1], m[2]);
      }
    }
    if (c === '\n') {
      lineStart = true;
      i++;
    } else if (c === '#' || at('//')) {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (at('/*')) {
      i = text.indexOf('*/', i + 2) + 2;
    } else if (at('<<')) {
      const m = /^<<-?([A-Z_]+)\n/.exec(text.slice(i));
      if (m) {
        const end = new RegExp(`\\n\\s*${m[1]}\\s*(\\n|$)`).exec(text.slice(i + m[0].length - 1));
        i += m[0].length - 1 + (end ? end.index + end[0].length - 1 : text.length);
      } else i += 2;
    } else if (c === '"') {
      // A string, with ${...} interpolations that may hold strings of their own.
      i++;
      let interp = 0;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (interp === 0 && text[i] === '"') break;
        else if (text.startsWith('${', i)) {
          interp++;
          i += 2;
        } else if (interp > 0 && text[i] === '}') {
          interp--;
          i++;
        } else if (interp > 0 && text[i] === '"') {
          i = text.indexOf('"', i + 1) + 1;
        } else i++;
      }
      i++;
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (depth === 0 && current) {
        found.push(current);
        current = null;
      }
    } else i++;
  }
  return found;
}

const problems = [];
let checked = 0;
let tagged = 0;
for (const file of tfFiles(root)) {
  const rel = relative(root, file).replaceAll('\\', '/');
  const setup = rel.split('/')[0];
  for (const r of resources(readFileSync(file, 'utf8'))) {
    checked++;
    const where = `${rel}: ${r.type}.${r.name}`;
    const forbidden = [...FORBIDDEN.everywhere, ...(FORBIDDEN[setup] ?? [])];
    if (forbidden.includes(r.type)) problems.push(`${where}: ${r.type} is not allowed in ${setup}`);
    if (!taggable.has(r.type)) continue;
    tagged++;
    const tags = r.args.get('tags');
    if (tags === undefined) problems.push(`${where}: supports tags but sets none`);
    else if (!/\b(local|var)\.tags\b/.test(tags)) {
      problems.push(`${where}: tags must come from local.tags (or var.tags in a module)`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `${checked} resources checked: all ${tagged} that support tags are tagged; ` +
    'no NAT gateway, and no load balancer in the demo.',
);
