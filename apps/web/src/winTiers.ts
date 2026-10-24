import type { Card } from '@pokerclause/engine';

/**
 * How big a trophy celebration a winning hand earns (see
 * components/TrophyCelebration.tsx): 0 for anything below a straight —
 * those keep the plain "You Win!" banner — then one step per hand class,
 * so every better hand gets a bigger show. A royal flush is the engine's
 * "straight flush" that runs to the ace (an ace AND a king in it — the
 * wheel straight flush has an ace but no king).
 */
export type WinTier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WIN_TIER_NAMES: Record<Exclude<WinTier, 0>, string> = {
  1: 'Straight',
  2: 'Flush',
  3: 'Full House',
  4: 'Four of a Kind',
  5: 'Straight Flush',
  6: 'Royal Flush',
};

// Names as poker-evaluator spells them (see engine/src/evaluator.ts).
const TIER_BY_HAND_NAME: Record<string, WinTier> = {
  straight: 1,
  flush: 2,
  'full house': 3,
  'four of a kind': 4,
  'straight flush': 5,
};

export function winTierOf(handName: string | undefined, bestFive: readonly Card[] | undefined): WinTier {
  const tier = handName ? (TIER_BY_HAND_NAME[handName.toLowerCase()] ?? 0) : 0;
  if (tier === 5 && bestFive) {
    const ranks = new Set(bestFive.map((c) => c.slice(0, -1)));
    if (ranks.has('A') && ranks.has('K')) return 6;
  }
  return tier;
}
