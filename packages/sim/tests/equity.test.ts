import type { Card } from '@pokerclause/engine';
import { seededSource } from '@pokerclause/rng';
import { describe, expect, it } from 'vitest';
import { estimateEquity } from '../src/bots/equity.js';

// Real-world reference values (widely published, e.g. any standard preflop
// equity table): pocket aces is ~85% to win heads-up preflop against a
// random hand; 7-2 offsuit (the conventional "worst starting hand") is
// ~32-33%. A Monte Carlo estimate at a few thousand samples should land
// close to those, well outside the noise floor of a bad implementation
// (e.g. an accidentally-inverted win/lose comparison would land near 15%
// and 68% respectively — the wrong side of 50/50 for both).
describe('estimateEquity', () => {
  it('pocket aces is a big preflop favorite heads-up against a random hand', () => {
    const equity = estimateEquity(['As', 'Ah'], [], 1, seededSource('equity-test-AA'), 3000);
    expect(equity).toBeGreaterThan(0.78);
    expect(equity).toBeLessThan(0.92);
  });

  it('7-2 offsuit is a big preflop underdog heads-up against a random hand', () => {
    const equity = estimateEquity(['7c', '2d'], [], 1, seededSource('equity-test-72o'), 3000);
    expect(equity).toBeGreaterThan(0.24);
    expect(equity).toBeLessThan(0.4);
  });

  it('effectively the nuts on the river is close to 100% equity', () => {
    // Hero holds four deuces (quads) — nothing beats that except a
    // straight flush, which a single random opponent hand will produce
    // vanishingly rarely.
    const board: Card[] = ['2c', '2d', '2h', '5s', '9c'];
    const equity = estimateEquity(['2s', 'Ah'], board, 1, seededSource('equity-test-quads'), 1000);
    expect(equity).toBeGreaterThan(0.99);
  });

  it('more live opponents lowers equity for the same hand', () => {
    const rnd = seededSource('equity-test-opponent-count');
    const vsOne = estimateEquity(['Jc', 'Jd'], [], 1, rnd, 2000);
    const vsFour = estimateEquity(['Jc', 'Jd'], [], 4, rnd, 2000);
    expect(vsFour).toBeLessThan(vsOne);
  });

  it('is deterministic for a given seed', () => {
    const a = estimateEquity(['Kc', 'Kd'], [], 2, seededSource('equity-determinism'), 500);
    const b = estimateEquity(['Kc', 'Kd'], [], 2, seededSource('equity-determinism'), 500);
    expect(a).toBe(b);
  });
});
