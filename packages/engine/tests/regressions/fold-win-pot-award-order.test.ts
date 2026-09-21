import { describe, expect, it } from 'vitest';
import { applyAction, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

/**
 * Regression: found by the M2 simulation harness (invariant: side pots
 * must be awarded before the main pot). awardFoldWin iterated
 * `draft.pots` in ascending (ascending index / main-pot-first) order,
 * unlike runShowdown's descending order. A fold-win can still involve
 * multiple pot tiers (each folded contributor at a different level still
 * anchors its own tier, all eligible only to the sole survivor), so the
 * award-order events for a fold-win must also go side-pots-first.
 */
describe('regression: a fold-win still awards side pots before the main pot', () => {
  it('emits pot-awarded events in descending potIndex order even when one player wins by fold', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'A', stack: 200 },
      { seatId: 1, playerId: 'B', stack: 200 },
      { seatId: 2, playerId: 'C', stack: 500 },
    ]);
    const started = expectOk(startHand(t, orderedDeck('2c', '3c', '4c', '5c', '6c', '7c')));
    // 3-handed: button=0, sb=1, bb=2; order: BTN(0) -> SB(1) -> BB(2).
    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'raise', amountTo: 10 }));
    const s2 = expectOk(applyAction(s1, { seatId: 1, type: 'raise', amountTo: 50 }));
    const s3 = expectOk(applyAction(s2, { seatId: 2, type: 'raise', amountTo: 100 }));
    // Action reopens back to A, who folds at 10; then B folds at 50,
    // leaving C (the sole survivor) to win by default — but A's and B's
    // different folded contribution levels still each anchor their own
    // pot tier, all eligible only to C.
    const s4 = expectOk(applyAction(s3, { seatId: 0, type: 'fold' }));
    const result = applyAction(s4, { seatId: 1, type: 'fold' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.state.phase).toBe('hand-complete');
    expect(result.state.pots.length).toBeGreaterThanOrEqual(2);

    const potAwardIndexes = result.events.filter((e) => e.type === 'pot-awarded').map((e) => e.potIndex);
    for (let i = 1; i < potAwardIndexes.length; i++) {
      expect(potAwardIndexes[i]!).toBeLessThan(potAwardIndexes[i - 1]!);
    }
  });
});
