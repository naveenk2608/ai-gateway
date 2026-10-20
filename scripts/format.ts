/**
 * Runs Prettier on the files git treats as part of the repo: tracked files plus new files that git
 * does not ignore. Anything git ignores (.gitignore, local excludes) is skipped as well.
 *
 * Usage: tsx scripts/format.ts --check | --write
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as prettier from 'prettier';

const write = process.argv.includes('--write');

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter((file) => file !== '' && existsSync(file));

let checked = 0;
const unformatted: string[] = [];

for (const file of files) {
  const info = await prettier.getFileInfo(file, { ignorePath: '.prettierignore' });
  if (info.ignored || info.inferredParser === null) continue;

  const config = await prettier.resolveConfig(file, { editorconfig: true });
  const options = { ...config, filepath: file };
  const source = await readFile(file, 'utf8');
  checked++;

  if (write) {
    const formatted = await prettier.format(source, options);
    if (formatted !== source) {
      await writeFile(file, formatted);
      process.stdout.write(`formatted ${file}\n`);
    }
  } else if (!(await prettier.check(source, options))) {
    unformatted.push(file);
  }
}

if (unformatted.length > 0) {
  process.stderr.write(
    `Not formatted with Prettier:\n${unformatted.map((f) => `  ${f}`).join('\n')}\n` +
      'Run `pnpm format` to fix.\n',
  );
  process.exitCode = 1;
} else if (!write) {
  process.stdout.write(`All ${checked} files use Prettier code style.\n`);
}
