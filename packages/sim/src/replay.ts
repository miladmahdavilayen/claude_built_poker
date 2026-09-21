import { applyAction, startHand, type Card, type PlayerAction, type TableState } from '@pokerclause/engine';

/**
 * Re-derives a hand's final state purely from its starting state, the
 * deck used, and the log of actions actually applied. The engine has no
 * internal randomness (M1's core guarantee), so this must reproduce the
 * live run's final state byte-for-byte — this is what will later let a
 * server reconstruct any hand from its database action log.
 */
export function replayHand(initialState: TableState, deck: readonly Card[], actionLog: readonly PlayerAction[]): TableState {
  const started = startHand(initialState, deck);
  if (!started.ok) {
    throw new Error(`replay: startHand failed unexpectedly: ${started.error.code}: ${started.error.message}`);
  }
  let state = started.state;
  for (const action of actionLog) {
    const result = applyAction(state, action);
    if (!result.ok) {
      throw new Error(`replay: applyAction failed unexpectedly for ${JSON.stringify(action)}: ${result.error.code}: ${result.error.message}`);
    }
    state = result.state;
  }
  return state;
}

/** Deep, order-sensitive structural equality (JSON round-trip is sufficient — TableState is plain data). */
export function statesAreIdentical(a: TableState, b: TableState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
