import { describe, expect, it } from 'vitest';
import { applyAction, createTableState, fullDeck, getLegalActions, startHand } from '../src/index.js';
import { expectOk } from './helpers.js';
import type { TableState } from '../src/types.js';

// A player who changed seats away from the big blind owes one, posted live
// on the next hand they're dealt into (src/hand.ts, DECISIONS.md "Changing seats").

const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, straddleEnabled: false };

function table(owing: number[]): TableState {
  const t = createTableState(config, [
    { seatId: 0, playerId: 'BTN', stack: 200 },
    { seatId: 1, playerId: 'SB', stack: 200 },
    { seatId: 2, playerId: 'BB', stack: 200 },
    { seatId: 4, playerId: 'MOVER', stack: 200 },
  ]);
  return { ...t, seats: t.seats.map((s) => (owing.includes(s.seatId) ? { ...s, missedBigBlind: true } : s)) };
}

describe('owed big blind after a seat change', () => {
  it('a seat outside the blinds posts a live big blind, and can check its option', () => {
    let s = expectOk(startHand(table([4]), fullDeck()));
    expect(s.seats[4]!.committedThisStreet).toBe(2);
    expect(s.seats[4]!.stack).toBe(198);
    expect(s.seats[4]!.missedBigBlind).toBe(false);
    expect(s.betting.currentBet).toBe(2);
    // UTG is seat 4 itself here: it's in for the big blind already, so it may check.
    expect(s.betting.actingSeat).toBe(4);
    expect(getLegalActions(s, 4).canCheck).toBe(true);
    s = expectOk(applyAction(s, { seatId: 4, type: 'check' }));
    expect(s.betting.actingSeat).toBe(0);
  });

  it('the small blind tops up to a full big blind; the big blind owes nothing more', () => {
    const s = expectOk(startHand(table([1, 2]), fullDeck()));
    expect(s.seats[1]!.committedThisStreet).toBe(2);
    expect(s.seats[2]!.committedThisStreet).toBe(2);
    expect(s.seats[2]!.stack).toBe(198);
    expect(s.seats.every((x) => !x.missedBigBlind)).toBe(true);
  });

  it('a seat sitting out keeps owing it until it is dealt in', () => {
    const t = table([4]);
    const out = { ...t, seats: t.seats.map((x) => (x.seatId === 4 ? { ...x, status: 'sitting-out' as const } : x)) };
    const s = expectOk(startHand(out, fullDeck()));
    expect(s.seats[4]!.missedBigBlind).toBe(true);
    expect(s.seats[4]!.stack).toBe(200);
  });
});
