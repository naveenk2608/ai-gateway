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
    // Tests never touch a real AWS account: the AWS SDK gets no shared config or credentials
    // files to read and no instance metadata to ask; SQS tests run against LocalStack.
    env: {
      AWS_CONFIG_FILE: fromRoot('./test/no-aws-config'),
      AWS_SHARED_CREDENTIALS_FILE: fromRoot('./test/no-aws-credentials'),
      AWS_EC2_METADATA_DISABLED: 'true',
    },
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
