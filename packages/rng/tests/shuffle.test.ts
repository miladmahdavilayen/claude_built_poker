import { describe, expect, it } from 'vitest';
import { seededSource } from '../src/seededSource.js';
import { shuffle, freshDeck } from '../src/shuffle.js';

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

describe('shuffle: Fisher-Yates over a RandomSource', () => {
  it('covers all 120 permutations of a 5-element array within chi-square tolerance over 500,000 runs', () => {
    const src = seededSource('shuffle-coverage-seed');
    const items = [0, 1, 2, 3, 4];
    const seen = new Map<string, number>();
    const n = 500_000;
    for (let i = 0; i < n; i++) {
      const key = shuffle(items, src).join(',');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    const totalPermutations = factorial(5);
    expect(totalPermutations).toBe(120);
    expect(seen.size).toBe(totalPermutations);

    const expectedEach = n / totalPermutations;
    let chiSquareStat = 0;
    for (const count of seen.values()) {
      chiSquareStat += (count - expectedEach) ** 2 / expectedEach;
    }
    // df = 119; a correct Fisher-Yates should land near df. A biased
    // shuffle (e.g. sort-by-random-comparator) blows this up by 10-100x.
    expect(chiSquareStat).toBeLessThan(200);
  });

  it('never drops or duplicates an element', () => {
    const src = seededSource('shuffle-integrity-seed');
    const items = freshDeck();
    for (let i = 0; i < 1000; i++) {
      const shuffled = shuffle(items, src);
      expect(shuffled).toHaveLength(52);
      expect(new Set(shuffled).size).toBe(52);
    }
  });

  it('does not mutate the input array', () => {
    const src = seededSource('shuffle-purity-seed');
    const items = [1, 2, 3, 4, 5];
    const snapshot = [...items];
    shuffle(items, src);
    expect(items).toEqual(snapshot);
  });
});

describe('freshDeck', () => {
  it('returns 52 unique canonical cards', () => {
    const deck = freshDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });
});
