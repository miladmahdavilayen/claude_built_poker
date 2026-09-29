import type { Card } from '@pokerclause/engine';

// Deliberately NOT importing @pokerclause/engine's own rankIndex/suitOf
// (or anything else as a real value, only its Card TYPE, which is erased
// at build time) — that package's index.ts is one barrel file that also
// re-exports its server-only hand evaluator, which pulls in the
// `poker-evaluator` Node package (fs/path/__dirname). Bundled into this
// browser app, that throws at runtime ("__dirname is not defined") and
// blanks the entire page — found by actually loading the page, not by
// tsc/eslint. RANKS mirrors engine/src/deck.ts's own rank ordering.
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
function rankIndexOf(card: Card): number {
  return RANKS.indexOf(card.slice(0, -1));
}
function suitOf(card: Card): string {
  return card.slice(-1);
}

/**
 * Cheap "did they actually have it" classifier for the voluntary
 * post-fold-win reveal button's label and its reveal sound (see
 * RevealHandButton.tsx and useJustRevealedSeats.ts) — deliberately NOT the
 * real hand evaluator (@pokerclause/engine's PokerToolsEvaluator lives
 * server-side and ranks a winner against contenders; this never decides
 * who wins anything). It only needs a binary answer: does the best
 * made hand from these cards clear "no pair, no straight, no flush" (a
 * bluff, by this feature's own definition) or not?
 *
 * Preflop (board.length < 3) can't be classified either way with only 2
 * cards — always "not a bluff" in that case, so the button falls back to
 * the neutral "Reveal Hand" label rather than guessing.
 */
export function isBluffHand(holeCards: readonly Card[], board: readonly Card[]): boolean {
  if (board.length < 3 || holeCards.length < 2) return false;
  const cards = [...holeCards, ...board];

  const rankCounts = new Map<number, number>();
  for (const c of cards) {
    const r = rankIndexOf(c);
    rankCounts.set(r, (rankCounts.get(r) ?? 0) + 1);
  }
  if ([...rankCounts.values()].some((count) => count >= 2)) return false; // pair or better

  const suitCounts = new Map<string, number>();
  for (const c of cards) suitCounts.set(suitOf(c), (suitCounts.get(suitOf(c)) ?? 0) + 1);
  if ([...suitCounts.values()].some((count) => count >= 5)) return false; // flush

  // Ace (rankIndex 12) also plays low for a wheel straight (A-2-3-4-5).
  const ranks = new Set(rankCounts.keys());
  if (ranks.has(12)) ranks.add(-1);
  const sorted = [...ranks].sort((a, b) => a - b);
  for (let i = 0; i + 4 < sorted.length; i++) {
    if (sorted[i + 4]! - sorted[i]! === 4) return false; // straight
  }

  return true; // no pair, no flush, no straight: genuinely nothing
}
