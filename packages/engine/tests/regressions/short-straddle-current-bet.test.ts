import { describe, expect, it } from 'vitest';
import { startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

/**
 * Regression: found by the M2 simulation harness at scale (50k hands),
 * invariant #7 ("currentBet must equal the max committedThisStreet").
 * The straddle branch unconditionally set currentBet = straddleAmount,
 * even when a short-stacked UTG's all-in straddle was LESS than the big
 * blind already posted — silently lowering currentBet below what BB had
 * already committed. Same class of bug as the short-blind fix: a short
 * forced post that doesn't reach the existing bet is a forced short
 * call, never a raise, and must not move currentBet or the aggressor.
 */
describe('regression: a short all-in straddle never lowers currentBet below the BB', () => {
  it('a straddle smaller than the big blind leaves currentBet at the BB amount', () => {
    const config = { smallBlind: 16, bigBlind: 32, ante: 0, maxSeats: 4, straddleEnabled: true };
    // First hand: button=0, sb=1, bb=2; UTG (the straddler) = seat 3.
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 500 },
      { seatId: 3, playerId: 'UTG', stack: 6 }, // will straddle all-in for only 6 (< BB's 32)
    ]);
    const started = expectOk(startHand(t, orderedDeck('2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c')));

    expect(started.straddleSeat).toBe(3);
    expect(started.seats[3]!.committedThisStreet).toBe(6);
    expect(started.seats[3]!.status).toBe('all-in');
    // currentBet must stay at the BB's 32, not drop to the short straddle's 6.
    expect(started.betting.currentBet).toBe(32);
    expect(started.betting.currentBet).toBe(Math.max(...started.seats.map((s) => s.committedThisStreet)));
    expect(started.betting.lastAggressorSeat).toBe(2); // BB, not the short straddler
  });
});
