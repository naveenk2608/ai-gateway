import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run workspace packages from source, so no build step is needed first.
    alias: [
      {
        find: /^@ai-gateway\/shared$/,
        replacement: fromRoot('./packages/shared/src/index.ts'),
      },
      {
        find: /^@ai-gateway\/shared\/node$/,
        replacement: fromRoot('./packages/shared/src/node/index.ts'),
      },
      {
        find: /^@ai-gateway\/worker$/,
        replacement: fromRoot('./apps/worker/src/index.ts'),
      },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            '{apps,packages}/*/src/**/*.test.{ts,tsx}',
            'scripts/**/*.test.ts',
            'bench/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['apps/*/test/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/integration-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
