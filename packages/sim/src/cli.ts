import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './cliArgs.js';
import { CoverageCounters } from './coverage.js';
import { runSimulation, type RecordedFailure } from './harness.js';
import { StatsCollector } from './stats.js';

const workerUrl = fileURLToPath(new URL('./workerEntry.mjs', import.meta.url));

interface WorkerResult {
  handsPlayed: number;
  elapsedMs: number;
  coverage: Record<string, number>;
  statsSnapshot: ReturnType<StatsCollector['toSnapshot']>;
  failures: RecordedFailure[];
  replayMismatches: number;
}

function runWorker(seed: string, hands: number, seats: number | 'random', mix: string, failFast: boolean, reproDir: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { hands, seats, seed, mix, failFast, reproDir },
    });
    worker.once('message', (msg: WorkerResult) => {
      resolve(msg);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  process.stdout.write(
    `Running ${String(args.hands)} hands (seats=${String(args.seats)}, mix=${args.mix}, seed=${args.seed}, workers=${String(args.workers)})...\n`,
  );

  if (args.workers <= 1) {
    const onProgress = (done: number): void => {
      if (done % 10000 === 0) process.stdout.write(`  ...${String(done)} hands\n`);
    };
    const summary = runSimulation({
      hands: args.hands,
      seats: args.seats,
      seed: args.seed,
      mix: args.mix,
      failFast: args.failFast,
      verbose: args.verbose,
      reproDir: args.reproDir,
      ...(args.verbose ? { onProgress } : {}),
    });
    printSummary(summary.handsPlayed, summary.elapsedMs, summary.coverage, summary.statsResults, summary.failures, summary.replayMismatches);
    process.exitCode = summary.failures.length === 0 && summary.replayMismatches === 0 ? 0 : 1;
    return;
  }

  const perWorker = Math.ceil(args.hands / args.workers);
  const jobs = Array.from({ length: args.workers }, (_, i) =>
    runWorker(`${args.seed}:worker:${String(i)}`, perWorker, args.seats, args.mix, args.failFast, args.reproDir),
  );
  const results = await Promise.all(jobs);

  const coverage = new CoverageCounters();
  const stats = new StatsCollector();
  let handsPlayed = 0;
  let elapsedMs = 0;
  let failures: RecordedFailure[] = [];
  let replayMismatches = 0;
  for (const r of results) {
    for (const [k, v] of Object.entries(r.coverage)) coverage.bump(k as Parameters<CoverageCounters['bump']>[0], v);
    stats.mergeSnapshot(r.statsSnapshot);
    handsPlayed += r.handsPlayed;
    elapsedMs = Math.max(elapsedMs, r.elapsedMs);
    failures = failures.concat(r.failures);
    replayMismatches += r.replayMismatches;
  }

  printSummary(handsPlayed, elapsedMs, coverage, stats.report(), failures, replayMismatches);
  process.exitCode = failures.length === 0 && replayMismatches === 0 ? 0 : 1;
}

function printSummary(
  handsPlayed: number,
  elapsedMs: number,
  coverage: CoverageCounters,
  statsResults: ReturnType<StatsCollector['report']>,
  failures: RecordedFailure[],
  replayMismatches: number,
): void {
  const handsPerSecond = elapsedMs > 0 ? (handsPlayed / elapsedMs) * 1000 : handsPlayed;
  process.stdout.write('\n=== Run summary ===\n');
  process.stdout.write(`Hands played:     ${String(handsPlayed)}\n`);
  process.stdout.write(`Elapsed:          ${(elapsedMs / 1000).toFixed(2)}s\n`);
  process.stdout.write(`Hands/sec:        ${handsPerSecond.toFixed(0)}\n`);
  process.stdout.write(`Failures:         ${String(failures.length)}\n`);
  process.stdout.write(`Replay mismatches:${String(replayMismatches)}\n`);

  process.stdout.write('\n=== Coverage counters ===\n');
  process.stdout.write(coverage.toTable() + '\n');
  const zero = coverage.zeroKeys();
  if (zero.length > 0) {
    process.stdout.write(`\nZERO-COUNT coverage keys (should be none for a full run): ${zero.join(', ')}\n`);
  }

  process.stdout.write('\n=== Statistical checks ===\n');
  for (const r of statsResults) {
    process.stdout.write(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}\n`);
  }

  if (failures.length > 0) {
    process.stdout.write('\n=== Failures ===\n');
    for (const f of failures.slice(0, 20)) {
      process.stdout.write(`  hand ${String(f.handIndex)}: [${f.violation.code}] ${f.violation.message}${f.reproFile ? ` -> ${f.reproFile}` : ''}\n`);
    }
    if (failures.length > 20) process.stdout.write(`  ...and ${String(failures.length - 20)} more\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
