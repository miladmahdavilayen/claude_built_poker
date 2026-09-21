import { describe, expect, it } from 'vitest';
import { applyAction, getLegalActions, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectErr, expectOk, orderedDeck } from '../helpers.js';

/**
 * Regression: found by the M2 simulation harness (invariant #7,
 * "currentBet must equal the max committedThisStreet"). A seat whose
 * entire remaining stack didn't even reach the current bet was still
 * reported as canRaise=true, and applyAction accepted a "raise" to an
 * amount BELOW currentBet — silently lowering the effective currentBet
 * and desyncing it from every other seat's committedThisStreet. Going
 * all-in for less than what's already owed is a short CALL, never a
 * raise, regardless of the reopening rule.
 */
describe('regression: an all-in that does not reach currentBet is a call, not a raise', () => {
  it('getLegalActions reports canRaise=false when the seat cannot even reach currentBet', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 90 }, // will face a much bigger bet
      { seatId: 2, playerId: 'BB', stack: 500 },
    ]);
    const started = expectOk(startHand(t, orderedDeck('2c', '3c', '4c', '5c', '6c', '7c')));
    // BTN raises to 300 (far more than SB's whole stack).
    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'raise', amountTo: 300 }));

    const legalSb = getLegalActions(s1, 1);
    expect(legalSb.canRaise).toBe(false);
    expect(legalSb.canCall).toBe(true);
    expect(legalSb.callAmount).toBe(89); // SB's entire remaining stack

    const rejected = applyAction(s1, { seatId: 1, type: 'raise', amountTo: 90 });
    expect(expectErr(rejected)).toBe('RAISE_NOT_ALLOWED');

    const accepted = expectOk(applyAction(s1, { seatId: 1, type: 'call' }));
    expect(accepted.seats[1]!.stack).toBe(0);
    expect(accepted.seats[1]!.committedThisStreet).toBe(90);
    // currentBet must stay at BTN's 300 — SB's short call never lowers it.
    expect(accepted.betting.currentBet).toBe(300);
    expect(accepted.betting.currentBet).toBe(Math.max(...accepted.seats.map((s) => s.committedThisStreet)));
  });
});
