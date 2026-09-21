import { fullDeck, type Card } from '@pokerclause/engine';
import type { RandomSource } from './randomSource.js';

/** Fisher-Yates, iterating downward, drawing j uniformly from [0, i]. */
export function shuffle<T>(items: readonly T[], src: RandomSource): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = src.nextInt(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/** 52 cards, canonical order (delegates to the engine's own definition). */
export function freshDeck(): Card[] {
  return fullDeck();
}
