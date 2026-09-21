import { createDefaultEvaluator, rankIndex, suitOf, type Card } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { SeatView } from '../types.js';

const evaluator = createDefaultEvaluator();

export function pickUniform<T>(items: readonly T[], rnd: RandomSource): T {
  if (items.length === 0) throw new Error('pickUniform: empty list');
  return items[rnd.nextInt(items.length)]!;
}

export function randomBetween(min: number, max: number, rnd: RandomSource): number {
  if (max <= min) return min;
  return min + rnd.nextInt(max - min + 1);
}

/** Weighted toward the high end of [min, max] (used by aggressive bots). */
export function randomBetweenHighBias(min: number, max: number, rnd: RandomSource): number {
  if (max <= min) return min;
  const a = randomBetween(min, max, rnd);
  const b = randomBetween(min, max, rnd);
  return Math.max(a, b);
}

/** Rough top-~20% preflop starting-hand heuristic: pairs, broadways, suited aces/kings. */
export function isPremiumPreflop(holeCards: readonly Card[]): boolean {
  if (holeCards.length !== 2) return false;
  const [a, b] = holeCards as [Card, Card];
  const ra = rankIndex(a);
  const rb = rankIndex(b);
  const suited = suitOf(a) === suitOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  const TEN = rankIndex('Ts');
  const EIGHT = rankIndex('8s');
  const ACE = rankIndex('As');
  if (ra === rb) return true; // any pocket pair
  if (hi >= TEN && lo >= TEN) return true; // both broadway (T,J,Q,K,A)
  if (suited && lo >= EIGHT) return true; // suited 8+ connectors/broadways
  if (hi === ACE && (suited || lo >= EIGHT)) return true; // ace-suited or ace-8+
  return false;
}

/** Looser push/fold-range heuristic for short stacks (~40% of hands). */
export function isPlayablePreflop(holeCards: readonly Card[]): boolean {
  if (holeCards.length !== 2) return false;
  if (isPremiumPreflop(holeCards)) return true;
  const [a, b] = holeCards as [Card, Card];
  const ra = rankIndex(a);
  const rb = rankIndex(b);
  const suited = suitOf(a) === suitOf(b);
  const hi = Math.max(ra, rb);
  const FIVE = rankIndex('5s');
  return hi >= FIVE || suited;
}

/** Whether this seat currently holds at least a pair using board + hole cards. */
export function hasMadeHand(board: readonly Card[], holeCards: readonly Card[]): boolean {
  if (board.length < 3 || holeCards.length !== 2) return false;
  const result = evaluator.evaluate([...board, ...holeCards]);
  return !result.name.toLowerCase().includes('high card');
}

export function ownSeat(view: SeatView) {
  const seat = view.seats.find((s) => s.seatId === view.seatId);
  if (!seat) throw new Error(`unreachable: seat ${String(view.seatId)} missing from its own SeatView`);
  return seat;
}
