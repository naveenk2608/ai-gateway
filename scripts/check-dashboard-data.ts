/**
 * Fails when dashboard source holds data written by hand: an array literal with numbers in it
 * (directly or in objects), or a literal passed as a chart's `data`. Every number the dashboard
 * shows must come from the API. Tests are not scanned.
 *
 * A line can be allowed with `// hardcoded-data-ok: <reason>` on the line before it.
 *
 * Usage: tsx scripts/check-dashboard-data.ts [dir]   (default apps/dashboard/src)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface Finding {
  line: number;
  message: string;
}

const ALLOW = /\/\/\s*hardcoded-data-ok:\s*\S/;

function isNumber(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node)) return true;
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  );
}

/** An element that carries numbers by itself: a number, or an object with a number value. */
function holdsNumbers(node: ts.Node): boolean {
  if (isNumber(node)) return true;
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some(
      (p) => ts.isPropertyAssignment(p) && (isNumber(p.initializer) || holdsNumbers(p.initializer)),
    );
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(holdsNumbers);
  return false;
}

function containsLiteral(node: ts.Node): boolean {
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) return true;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
  return ts.forEachChild(node, (child) => (containsLiteral(child) ? true : undefined)) ?? false;
}

export function findHardcodedData(fileName: string, text: string): Finding[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines = text.split('\n');
  const findings: Finding[] = [];
  const report = (node: ts.Node, message: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (line > 0 && ALLOW.test(lines[line - 1] ?? '')) return;
    findings.push({ line: line + 1, message });
  };
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.some(holdsNumbers)) {
      report(node, 'array literal with numbers: data must come from the API');
      return;
    }
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'data' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      containsLiteral(node.initializer.expression)
    ) {
      report(node, 'literal passed as chart data: data must come from the API');
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'apps/dashboard/src';
  const files = sourceFiles(dir);
  let count = 0;
  for (const file of files) {
    for (const f of findHardcodedData(file, readFileSync(file, 'utf8'))) {
      console.error(`${relative(process.cwd(), file)}:${f.line}: ${f.message}`);
      count++;
    }
  }
  if (count > 0) {
    console.error(`${count} hard-coded data finding(s) in ${dir}.`);
    process.exit(1);
  }
  console.log(`No hard-coded data in ${files.length} files under ${dir}.`);
}
