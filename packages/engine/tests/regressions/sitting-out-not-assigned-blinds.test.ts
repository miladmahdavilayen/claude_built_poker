import { describe, expect, it } from 'vitest';
import { startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

/**
 * Regression: found by the M2 simulation harness (crashed inside
 * runShowdown with "Cannot read properties of undefined (reading
 * 'value')"). assignButtonAndBlinds used `occupiedRing`, which only
 * excludes truly empty seats — so a seat marked 'sitting-out' between
 * hands could still be assigned small or big blind, forced to post it,
 * and then be silently excluded from dealing and the action order (which
 * correctly only include 'active'/'all-in' seats). That seat's forced
 * blind contribution made it eligible for a pot at showdown despite
 * having no hole cards and never being a contender, crashing hand
 * evaluation. Sitting-out seats must be skipped for blind assignment
 * exactly like empty ones.
 */
describe('regression: a sitting-out seat is never assigned a blind', () => {
  it('button/blind assignment skips a sitting-out seat entirely', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 200 },
      { seatId: 1, playerId: 'SITTING', stack: 200 },
      { seatId: 2, playerId: 'BB', stack: 200 },
    ]);
    // Seat 1 is present but sitting out — must never be dealt in or posted for.
    const sittingOut = { ...t, seats: t.seats.map((s) => (s.seatId === 1 ? { ...s, status: 'sitting-out' as const } : s)) };

    const started = expectOk(startHand(sittingOut, orderedDeck('2c', '3c', '4c', '5c')));

    const seat1 = started.seats[1]!;
    expect(seat1.status).toBe('sitting-out');
    expect(seat1.committedThisHand).toBe(0);
    expect(seat1.committedThisStreet).toBe(0);
    expect(seat1.holeCards).toEqual([]);
    expect(started.buttonSeat).not.toBe(1);

    // Only the two active seats are dealt in and can ever be acting.
    expect(started.betting.actingSeat).not.toBe(1);
  });
});
