import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      // CLI entry points and their thin support modules are exercised via
      // real end-to-end `pnpm sim` / `pnpm sim:repro` runs (see the
      // project report), not vitest unit tests.
      exclude: ['src/cli.ts', 'src/reproCli.ts', 'src/goldenCli.ts', 'src/worker.ts', 'src/cliArgs.ts', 'src/reproWriter.ts'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
