import { describe, expect, it } from 'vitest';
import { applyAction, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

/**
 * Regression: found by the M2 simulation harness at scale (~50k hands),
 * crashed inside buildPots with "pot total 0 does not match contributions
 * N". A player whose entire 1-chip stack was consumed by the BB ante
 * (before they could post any of the actual big blind) ends up all-in
 * with committedThisHand=0 — a legitimate contender with a zero stake.
 * returnUncalledBet's "second highest contributor" defaulted to 0 when
 * there was only ONE seat with committedThisHand > 0, refunding that
 * seat's entire bet to zero and leaving buildPots with no contributors at
 * all to build a pot from, even though the ante still needed a home.
 */
describe('regression: an ante that drains a seat to zero does not corrupt uncalled-bet-return', () => {
  it('a sole real contributor still gets a valid pot when another contender has zero stake from an ante', () => {
    const config = { smallBlind: 4, bigBlind: 8, ante: 1, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 1 }, // ante alone consumes this entire stack
    ]);
    const started = expectOk(startHand(t, orderedDeck('2c', '3c', '4c', '5c', '6c', '7c')));

    const bb = started.seats[2]!;
    expect(bb.status).toBe('all-in');
    expect(bb.stack).toBe(0);
    expect(bb.committedThisStreet).toBe(0);
    expect(bb.committedThisHand).toBe(0);
    expect(started.anteTotal).toBe(1);

    // BTN folds, leaving SB (real chips) heads-up against the ante-drained BB.
    const result = applyAction(started, { seatId: 0, type: 'fold' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.state.phase).toBe('hand-complete');
    const totalPots = result.state.pots.reduce((sum, p) => sum + p.amount, 0);
    // SB's small blind (4) plus the ante (1); nothing is incorrectly "returned" to zero.
    expect(totalPots).toBe(4 + 1);
  });
});
