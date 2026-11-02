import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/', '**/coverage/', '**/node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Plain Node scripts CI runs without installing anything (the Terraform checks).
    files: ['infra/terraform/scripts/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    // The scheduled traffic script: plain Node 22, run without installing anything.
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        TextDecoder: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // k6 scripts run inside k6, which provides these globals.
    files: ['bench/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },
  {
    files: ['apps/{dashboard,playground}/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  prettier,
);
