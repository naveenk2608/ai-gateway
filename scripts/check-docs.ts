/**
 * Fails when the docs fall behind the code (M19), naming what is missing:
 *
 * - a setting of the gateway's or the worker's config schema that `.env.example` does not name;
 * - a `/v1` or `/admin` route the gateway registers that the README does not name as
 *   `METHOD /path` (with `:params` as registered);
 * - a table of `packages/shared/src/node/db.ts` that the README's data model table does not name.
 *
 * It reads files and the config schemas only: no network and no running gateway. Routes are found
 * in the gateway's source by their registration calls (`x.get('/v1/...')` and the like).
 *
 * Usage: tsx --conditions=development scripts/check-docs.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { gatewayConfigSchema } from '../apps/gateway/src/config.js';
import { workerConfigSchema } from '../apps/worker/src/config.js';

export interface Route {
  method: string;
  path: string;
  file: string;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const API_PATH = /^\/(?:v1|admin)(?:\/|$)/;

/** Every `x.get('/v1/...')`-style registration in one source file, from its syntax tree. */
export function routesIn(file: string, text: string): Route[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const routes: Route[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const first = node.arguments[0];
      if (
        METHODS.has(method) &&
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        API_PATH.test(first.text)
      ) {
        routes.push({ method: method.toUpperCase(), path: first.text, file });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` names `METHOD /path` itself, not only a longer path that starts with it. */
export function namesRoute(text: string, route: Pick<Route, 'method' | 'path'>): boolean {
  return new RegExp(`${escape(`${route.method} ${route.path}`)}(?![\\w/:.-])`).test(text);
}

/** The settings `envExample` never names (as a whole word: set, commented out or described). */
export function missingSettings(names: Iterable<string>, envExample: string): string[] {
  return [...new Set(names)]
    .filter((name) => !new RegExp(`\\b${escape(name)}\\b`).test(envExample))
    .sort();
}

/** The table names of the `Database` interface in db.ts. */
export function databaseTables(dbTs: string): string[] {
  const source = ts.createSourceFile('db.ts', dbTs, ts.ScriptTarget.Latest, true);
  const tables: string[] = [];
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Database') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
          tables.push(member.name.text);
        }
      }
    }
  });
  return tables;
}

/** The README's data model section: from its heading to the next heading. */
export function dataModelSection(readme: string): string {
  const start = readme.indexOf('### Data model');
  if (start < 0) return '';
  const next = readme.slice(start + 1).search(/\n#{1,3} /);
  return next < 0 ? readme.slice(start) : readme.slice(start, start + 1 + next);
}

/** The tables the data model section does not name in backticks. */
export function missingTables(tables: readonly string[], readme: string): string[] {
  const section = dataModelSection(readme);
  return tables.filter((table) => !section.includes(`\`${table}\``));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

export interface DocsFindings {
  settings: string[];
  routes: Route[];
  tables: string[];
  /** How much was checked, so a parser that finds nothing cannot pass silently. */
  checked: { settings: number; routes: number; tables: number };
}

/** Runs the three checks on the repository at `root`. */
export function checkDocs(root: string): DocsFindings {
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const settings = [
    ...Object.keys(gatewayConfigSchema.shape),
    ...Object.keys(workerConfigSchema.shape),
  ];
  const readme = read('README.md');
  const routes = sourceFiles(join(root, 'apps/gateway/src')).flatMap((file) =>
    routesIn(relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')),
  );
  const tables = databaseTables(read('packages/shared/src/node/db.ts'));
  return {
    settings: missingSettings(settings, read('.env.example')),
    routes: routes.filter((route) => !namesRoute(readme, route)),
    tables: missingTables(tables, readme),
    checked: { settings: new Set(settings).size, routes: routes.length, tables: tables.length },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const found = checkDocs(root);
  for (const name of found.settings) console.error(`.env.example: setting ${name} is missing`);
  for (const r of found.routes) {
    console.error(`README.md: route ${r.method} ${r.path} (${r.file}) is not named`);
  }
  for (const table of found.tables) {
    console.error(`README.md: table ${table} is missing from the data model table`);
  }
  const count = found.settings.length + found.routes.length + found.tables.length;
  const { settings, routes, tables } = found.checked;
  if (count > 0 || settings === 0 || routes === 0 || tables === 0) {
    console.error(
      `${count} docs finding(s); checked ${settings} settings, ${routes} routes, ${tables} tables.`,
    );
    process.exit(1);
  }
  console.log(`Docs name all ${settings} settings, ${routes} routes and ${tables} tables.`);
}
