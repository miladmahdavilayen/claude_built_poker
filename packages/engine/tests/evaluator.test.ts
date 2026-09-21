import { describe, expect, it } from 'vitest';
import { createDefaultEvaluator } from '../src/evaluator.js';
import type { Card } from '../src/types.js';

const evaluator = createDefaultEvaluator();

function evaluate(...cards: Card[]) {
  return evaluator.evaluate(cards);
}

describe('hand evaluator', () => {
  it('ranks all 9 hand classes in the correct relative order (lower value = stronger)', () => {
    const royalFlush = evaluate('As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d');
    const straightFlush = evaluate('9s', '8s', '7s', '6s', '5s', '2c', '3d');
    const fourOfAKind = evaluate('9s', '9h', '9d', '9c', '5s', '2c', '3d');
    const fullHouse = evaluate('9s', '9h', '9d', '5c', '5s', '2c', '3d');
    const flush = evaluate('9s', '7s', '5s', '3s', 'Ks', '2c', '3d');
    const straight = evaluate('9s', '8h', '7d', '6c', '5s', '2c', '3d');
    const trips = evaluate('9s', '9h', '9d', '5c', '4s', '2c', '3d');
    const twoPair = evaluate('9s', '9h', '5d', '5c', '4s', '2c', '3d');
    const onePair = evaluate('9s', '9h', '5d', '4c', '3s', '2c', 'Jd');
    const highCard = evaluate('Ks', '9h', '5d', '4c', '2s', '7c', 'Jd');

    const ordered = [royalFlush, straightFlush, fourOfAKind, fullHouse, flush, straight, trips, twoPair, onePair, highCard];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(ordered[i]!.value).toBeLessThan(ordered[i + 1]!.value);
    }
    expect(royalFlush.name.toLowerCase()).toContain('straight flush');
    expect(fourOfAKind.name.toLowerCase()).toContain('four');
    expect(fullHouse.name.toLowerCase()).toContain('full house');
    expect(flush.name.toLowerCase()).toBe('flush');
    expect(straight.name.toLowerCase()).toBe('straight');
    expect(trips.name.toLowerCase()).toMatch(/three|trip/);
    expect(twoPair.name.toLowerCase()).toContain('two pair');
    expect(onePair.name.toLowerCase()).toContain('pair');
    expect(highCard.name.toLowerCase()).toContain('high card');
  });

  it('the wheel (A-2-3-4-5) is a valid straight, weaker than a 6-high straight', () => {
    const wheel = evaluate('As', '2h', '3d', '4c', '5s', '9c', 'Kd');
    const sixHigh = evaluate('6s', '5h', '4d', '3c', '2s', '9c', 'Kd');
    expect(wheel.name.toLowerCase()).toBe('straight');
    expect(wheel.value).toBeGreaterThan(sixHigh.value);
  });

  it('the steel wheel (A-2-3-4-5 suited) is a straight flush, the weakest one', () => {
    const steelWheel = evaluate('As', '2s', '3s', '4s', '5s', '9c', 'Kd');
    const sixHighStraightFlush = evaluate('6s', '5s', '4s', '3s', '2s', '9c', 'Kd');
    expect(steelWheel.name.toLowerCase()).toContain('straight flush');
    expect(steelWheel.value).toBeGreaterThan(sixHighStraightFlush.value);
    // Still beats a plain four of a kind.
    const quads = evaluate('9s', '9h', '9d', '9c', '5s', '2c', '3d');
    expect(steelWheel.value).toBeLessThan(quads.value);
  });

  it('the board plays: all five community cards beat both hole cards', () => {
    // Board itself is a straight flush; both hole cards are irrelevant low off-suit cards.
    const board: Card[] = ['9s', '8s', '7s', '6s', '5s'];
    const result = evaluate(...board, '2c', '3d');
    expect(result.name.toLowerCase()).toContain('straight flush');
    expect(new Set(result.bestFive)).toEqual(new Set(board));
  });

  it('breaks ties on kickers only when hand categories and pairs match', () => {
    const acesKingKicker = evaluate('As', 'Ah', 'Kd', '7c', '4s', '2d', '9h');
    const acesQueenKicker = evaluate('As', 'Ah', 'Qd', '7c', '4s', '2d', '9h');
    expect(acesKingKicker.value).toBeLessThan(acesQueenKicker.value);
  });

  it('selects the correct best-5-of-7 when several overlapping straights are possible', () => {
    // Ranks 3-9 contain three overlapping 5-card straights (3-7, 4-8, 5-9);
    // the evaluator must pick the highest one (5-6-7-8-9), not an earlier one.
    const sevenCards: Card[] = ['3d', '4c', '5s', '6h', '7d', '8c', '9h'];
    const result = evaluate(...sevenCards);
    expect(result.name.toLowerCase()).toBe('straight');
    expect(new Set(result.bestFive)).toEqual(new Set(['5s', '6h', '7d', '8c', '9h']));

    const sixCardsOnly: Card[] = ['3d', '4c', '5s', '6h', '7d', '8c'];
    const lower = evaluate(...sixCardsOnly);
    expect(lower.name.toLowerCase()).toBe('straight');
    expect(new Set(lower.bestFive)).toEqual(new Set(['4c', '5s', '6h', '7d', '8c']));
    expect(result.value).toBeLessThan(lower.value);
  });
});
