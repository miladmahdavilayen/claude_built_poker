import { describe, expect, it } from 'vitest';
import { runSimulation } from '../src/harness.js';

describe('perf', () => {
  it('measures throughput at 50k hands, balanced mix', () => {
    const summary = runSimulation({
      hands: 50000,
      seats: 'random',
      seed: 'perf-measure-seed',
      mix: 'balanced',
      failFast: true,
      verbose: false,
      reproDir: '/tmp/pokerclause-sim-perf-test',
    });
    console.log(`hands/sec: ${summary.handsPerSecond.toFixed(0)}, elapsedMs: ${summary.elapsedMs}, failures: ${summary.failures.length}`);
    expect(summary.failures).toEqual([]);
  });
});
