// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Plain-JS worker_threads bootstrap bridge for tsx (see its own doc
      // comment) — not part of the TS project, nothing to type-check.
      'packages/sim/src/workerEntry.mjs',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The two rules the spec explicitly requires, repo-wide:
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Math.random() is banned. Inject a RandomSource (see @pokerclause/rng) instead.',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Pure library packages: no console logging from library code.
    files: ['packages/engine/src/**/*.ts', 'packages/rng/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
);
