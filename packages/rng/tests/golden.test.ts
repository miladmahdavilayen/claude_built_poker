import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seededSource } from '../src/seededSource.js';
import { shuffle } from '../src/shuffle.js';
import { freshDeck } from '../src/shuffle.js';

/**
 * Committed golden vectors for seededSource('<seed>'). These pin the exact
 * byte stream (HMAC-SHA256 of an 8-byte big-endian counter, keyed by the
 * seed, starting at counter 0) so a future refactor can't silently change
 * the derived stream while `pnpm test` still passes. Any diff here must be
 * reviewed deliberately, per the spec.
 */
describe('seededSource: golden vectors', () => {
  it('matches the committed raw HMAC-SHA256 counter-mode byte stream', () => {
    const expectedHex = '864f939d92742f520d6818e5b6763b2cca8698f51e9f3d62f1641f90958cd808';
    const raw = createHmac('sha256', Buffer.from('golden-vector-seed-v1', 'utf8'))
      .update(Buffer.alloc(8)) // counter 0
      .digest();
    expect(raw.toString('hex')).toBe(expectedHex);
  });

  it('matches the committed nextInt(52) sequence for a fixed seed', () => {
    const src = seededSource('golden-vector-seed-v1');
    const draws = Array.from({ length: 10 }, () => src.nextInt(52));
    expect(draws).toEqual([6, 15, 19, 29, 18, 47, 18, 13, 40, 24]);
  });

  it('matches the committed full-deck shuffle for a fixed seed', () => {
    const src = seededSource('golden-deck-seed-v1');
    const shuffled = shuffle(freshDeck(), src);
    expect(shuffled).toEqual([
      '7s', 'Jd', 'Tc', '2c', '7d', 'As', 'Ts', '5s', 'Ks', 'Th', 'Qh', '2d', 'Qs', '7h', 'Qc', 'Jh', 'Kc', '3c',
      '9s', 'Ac', '5d', 'Td', '4d', '3d', '5c', 'Qd', 'Ad', '4s', '4c', '6s', '9c', '5h', '2s', 'Js', '4h', '2h',
      '6h', '3s', 'Ah', '8s', '8d', '8h', '9d', '3h', '8c', 'Jc', '7c', '9h', 'Kd', 'Kh', '6c', '6d',
    ]);
  });

  it('the same seed reproduces byte-identical output across independent instances', () => {
    const a = seededSource('reproducibility-seed');
    const b = seededSource('reproducibility-seed');
    const drawsA = Array.from({ length: 200 }, () => a.nextInt(37));
    const drawsB = Array.from({ length: 200 }, () => b.nextInt(37));
    expect(drawsA).toEqual(drawsB);
  });

  it('different seeds diverge', () => {
    const a = seededSource('seed-a');
    const b = seededSource('seed-b');
    const drawsA = Array.from({ length: 50 }, () => a.nextInt(1000));
    const drawsB = Array.from({ length: 50 }, () => b.nextInt(1000));
    expect(drawsA).not.toEqual(drawsB);
  });
});
