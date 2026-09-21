import { fullDeck } from '../src/deck.js';
import type { Card, EngineResult, TableState } from '../src/types.js';

/** A deterministic deck with `front` cards on top (dealt first), remaining 52-card cards filling the rest in a fixed order. */
export function orderedDeck(...front: Card[]): Card[] {
  const frontSet = new Set(front);
  if (frontSet.size !== front.length) throw new Error('duplicate card in test deck front');
  const rest = fullDeck().filter((c) => !frontSet.has(c));
  return [...front, ...rest];
}

export function expectOk(result: EngineResult): TableState {
  if (!result.ok) {
    throw new Error(`expected ok engine result, got error ${result.error.code}: ${result.error.message}`);
  }
  return result.state;
}

export function expectErr(result: EngineResult): string {
  if (result.ok) {
    throw new Error('expected engine error result, got ok');
  }
  return result.error.code;
}

/**
 * Sum of all chips in play. Mid-hand, committed chips haven't reached a
 * seat's stack yet, so they're counted via committedThisHand. Once a hand
 * completes, pot-awarded events have already added winnings back into
 * stacks, so `pots` (a historical record) must NOT be added again.
 */
export function totalChips(state: TableState): number {
  const inStacks = state.seats.reduce((sum, s) => sum + s.stack, 0);
  if (state.phase === 'hand-complete' || state.phase === 'waiting') return inStacks;
  const committedNotYetPotted = state.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
  return inStacks + committedNotYetPotted + state.anteTotal;
}
