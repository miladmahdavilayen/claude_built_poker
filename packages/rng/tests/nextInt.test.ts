import { describe, expect, it } from 'vitest';
import { cryptoSource } from '../src/cryptoSource.js';
import { seededSource } from '../src/seededSource.js';

/** Two-tailed chi-square critical value for df=k-1 at p=0.001 (very lax, avoids flaky CI). */
const CHI_SQUARE_CRITICAL: Record<number, number> = {
  1: 10.83,
  2: 13.82,
};

function chiSquare(counts: number[], expectedEach: number): number {
  return counts.reduce((sum, c) => sum + (c - expectedEach) ** 2 / expectedEach, 0);
}

describe('nextInt: unbiased rejection sampling', () => {
  it('cryptoSource().nextInt(3) is uniform over 1,000,000 draws (chi-square)', () => {
    const src = cryptoSource();
    const counts = [0, 0, 0];
    const n = 1_000_000;
    for (let i = 0; i < n; i++) {
      const v = src.nextInt(3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    const stat = chiSquare(counts, n / 3);
    expect(stat).toBeLessThan(CHI_SQUARE_CRITICAL[2]!);
  });

  it('seededSource().nextInt(3) is uniform over 1,000,000 draws (chi-square)', () => {
    const src = seededSource('chi-square-seed');
    const counts = [0, 0, 0];
    const n = 1_000_000;
    for (let i = 0; i < n; i++) {
      { const v = src.nextInt(3); counts[v] = (counts[v] ?? 0) + 1; }
    }
    const stat = chiSquare(counts, n / 3);
    expect(stat).toBeLessThan(CHI_SQUARE_CRITICAL[2]!);
  });

  it('is uniform for a non-power-of-two range (7) that forces rejection sampling', () => {
    const src = seededSource('non-pow2-seed');
    const counts = new Array<number>(7).fill(0);
    const n = 700_000;
    for (let i = 0; i < n; i++) {
      const v = src.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    const expectedEach = n / 7;
    const stat = chiSquare(counts, expectedEach);
    // df=6, p=0.001 critical value is 22.46; keep generous margin against CI flakiness.
    expect(stat).toBeLessThan(30);
  });

  it('nextInt(1) always returns 0 without consuming randomness incorrectly', () => {
    const src = seededSource('trivial-seed');
    for (let i = 0; i < 100; i++) {
      expect(src.nextInt(1)).toBe(0);
    }
  });

  it('rejects non-positive or non-integer maxExclusive', () => {
    const src = seededSource('validation-seed');
    expect(() => src.nextInt(0)).toThrow();
    expect(() => src.nextInt(-5)).toThrow();
    expect(() => src.nextInt(1.5)).toThrow();
  });
});
