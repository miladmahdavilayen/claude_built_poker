// Plain-JS wrapper required for worker_threads + tsx: `execArgv: ['--import',
// 'tsx/esm']` does not reliably apply to a Worker's own entry-file format
// resolution, and node:module's register() rejects being called this way
// too (see privatenumber/tsx#354). tsx's own programmatic `tsImport` API
// is built exactly for this: it transforms and imports a TS specifier
// directly, no global loader registration needed.
import { tsImport } from 'tsx/esm/api';

await tsImport('./worker.ts', import.meta.url);
