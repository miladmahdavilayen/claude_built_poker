import { parentPort, workerData } from 'node:worker_threads';
import { runSimulation, type BotMix } from './harness.js';

interface WorkerInput {
  hands: number;
  seats: number | 'random';
  seed: string;
  mix: BotMix;
  failFast: boolean;
  reproDir: string;
}

const input = workerData as WorkerInput;

const summary = runSimulation({
  hands: input.hands,
  seats: input.seats,
  seed: input.seed,
  mix: input.mix,
  failFast: input.failFast,
  verbose: false,
  reproDir: input.reproDir,
});

parentPort?.postMessage({
  handsPlayed: summary.handsPlayed,
  elapsedMs: summary.elapsedMs,
  coverage: summary.coverage.toJSON(),
  statsSnapshot: summary.statsSnapshot,
  failures: summary.failures,
  replayMismatches: summary.replayMismatches,
});
