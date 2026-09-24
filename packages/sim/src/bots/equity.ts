import { createDefaultEvaluator, fullDeck, type Card } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';

const evaluator = createDefaultEvaluator();

/**
 * Draws `count` distinct cards from `pool` uniformly at random via a
 * partial Fisher-Yates (only `count` swaps, never a full shuffle) —
 * `pool` is mutated in place, so callers pass a working copy they own for
 * that one sample. Uses ONLY `rnd`, never Math.random, so equity
 * estimation stays deterministic/replayable like the rest of the engine.
 */
function drawFrom(pool: Card[], count: number, rnd: RandomSource): Card[] {
  const drawn: Card[] = [];
  const n = pool.length;
  for (let i = 0; i < count; i++) {
    const j = i + rnd.nextInt(n - i);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
    drawn.push(pool[i]!);
  }
  return drawn;
}

/**
 * Monte Carlo equity of `holeCards` (+ known `board`) against `numOpponents`
 * random hands, each dealt from the cards not already known — i.e. equity
 * against a uniformly random range, not any modeled opponent range. That's
 * deliberately conservative: a real opponent's actual range, once they've
 * bet or called, is usually narrower and stronger than "any two cards", so
 * this never overestimates how good a hand is. Samples full board runouts
 * too when the board isn't complete yet, so the same function serves
 * preflop through the river without special-casing any street. Ties split
 * equity evenly among however many hands (mine and/or opponents') land on
 * the best value in that sample.
 */
export function estimateEquity(
  holeCards: readonly Card[],
  board: readonly Card[],
  numOpponents: number,
  rnd: RandomSource,
  samples: number,
): number {
  if (numOpponents <= 0) return 1;
  const known = new Set<Card>([...holeCards, ...board]);
  const basePool = fullDeck().filter((c) => !known.has(c));
  const boardCardsNeeded = 5 - board.length;
  const cardsPerSample = boardCardsNeeded + numOpponents * 2;
  if (cardsPerSample > basePool.length) return 0.5; // pathological/edge case — treat as a coinflip rather than throw

  let equitySum = 0;
  for (let s = 0; s < samples; s++) {
    const pool = basePool.slice();
    const drawnBoard = boardCardsNeeded > 0 ? drawFrom(pool, boardCardsNeeded, rnd) : [];
    const fullBoard = boardCardsNeeded > 0 ? [...board, ...drawnBoard] : board;

    const myValue = evaluator.evaluate([...holeCards, ...fullBoard]).value; // lower value = stronger hand
    let bestValue = myValue;
    let bestCount = 1; // tentatively "me", confirmed or displaced below

    for (let o = 0; o < numOpponents; o++) {
      const oppHole = drawFrom(pool, 2, rnd);
      const oppValue = evaluator.evaluate([...oppHole, ...fullBoard]).value;
      if (oppValue < bestValue) {
        bestValue = oppValue;
        bestCount = 1;
      } else if (oppValue === bestValue) {
        bestCount += 1;
      }
    }

    if (myValue === bestValue) equitySum += 1 / bestCount;
  }
  return equitySum / samples;
}
