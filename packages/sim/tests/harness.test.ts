import { describe, expect, it } from 'vitest';
import { runSimulation } from '../src/harness.js';

describe('runSimulation', () => {
  it('runs 5000 hands with a balanced mix and no invariant failures or replay mismatches', () => {
    const summary = runSimulation({
      hands: 5000,
      seats: 'random',
      seed: 'harness-smoke-seed',
      mix: 'balanced',
      failFast: true,
      verbose: false,
      reproDir: '/tmp/pokerclause-sim-failures-test',
    });

    expect(summary.failures).toEqual([]);
    expect(summary.replayMismatches).toBe(0);
    expect(summary.handsPlayed).toBe(5000);
  });

  it('runs 3000 hands with an adversarial mix and no invariant failures or replay mismatches', () => {
    const summary = runSimulation({
      hands: 3000,
      seats: 'random',
      seed: 'harness-adversarial-seed',
      mix: 'adversarial',
      failFast: true,
      verbose: false,
      reproDir: '/tmp/pokerclause-sim-failures-test',
    });

    expect(summary.failures).toEqual([]);
    expect(summary.replayMismatches).toBe(0);
  });

  it('is reproducible: the same seed produces byte-identical coverage counts', () => {
    const a = runSimulation({ hands: 1000, seats: 6, seed: 'repro-check-seed', mix: 'balanced', failFast: true, verbose: false, reproDir: '/tmp/pokerclause-sim-failures-test' });
    const b = runSimulation({ hands: 1000, seats: 6, seed: 'repro-check-seed', mix: 'balanced', failFast: true, verbose: false, reproDir: '/tmp/pokerclause-sim-failures-test' });
    expect(a.coverage.toJSON()).toEqual(b.coverage.toJSON());
  });
});
