import { describe, expect, it } from 'vitest';
import { startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

/**
 * Regression: found by the M2 simulation harness (invariant #7,
 * "currentBet must equal the max committedThisStreet"). A short-stacked
 * BB posting all-in for less than the nominal big blind left
 * `betting.currentBet` set to the nominal config amount instead of what
 * was actually posted, so nobody's committedThisStreet ever matched it.
 */
describe('regression: short blind post sets currentBet to the actual amount posted', () => {
  it('a short-stacked BB posting all-in for less sets currentBet to that amount, not the nominal big blind', () => {
    const config = { smallBlind: 1, bigBlind: 10, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 3 }, // short: can only post 3 of the nominal 10
    ]);
    const started = expectOk(startHand(t, orderedDeck('2c', '3c', '4c', '5c', '6c', '7c')));

    const bb = started.seats[2]!;
    expect(bb.stack).toBe(0);
    expect(bb.status).toBe('all-in');
    expect(bb.committedThisStreet).toBe(3);
    expect(started.betting.currentBet).toBe(3);
    expect(started.betting.currentBet).toBe(Math.max(...started.seats.map((s) => s.committedThisStreet)));
  });

  it('a short-stacked SB (shorter than the BB) still leaves currentBet at the BB amount', () => {
    const config = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 2 }, // short: can only post 2 of the nominal 5
      { seatId: 2, playerId: 'BB', stack: 500 },
    ]);
    const started = expectOk(startHand(t, orderedDeck('2c', '3c', '4c', '5c', '6c', '7c')));

    expect(started.seats[1]!.committedThisStreet).toBe(2);
    expect(started.seats[2]!.committedThisStreet).toBe(10);
    expect(started.betting.currentBet).toBe(10);
  });
});
