import { describe, expect, it } from 'vitest';
import { assignButtonAndBlinds } from '../../src/button.js';
import { createTableState } from '../../src/factory.js';
import { nextInRing, occupiedRing, toDraft } from '../../src/table.js';

describe('scenario 12: dead button / moving button across orbits with players leaving', () => {
  it('never skips a live seat for the big blind and never gives the same seat BB twice in a row', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, straddleEnabled: false };
    const t = createTableState(
      config,
      [0, 1, 2, 3, 4, 5].map((seatId) => ({ seatId, playerId: `P${String(seatId)}`, stack: 500 })),
    );
    const draft = toDraft(t);

    let lastBigBlindSeat: number | null = null;
    const bbHistory: number[] = [];

    // Orbit 1: everyone present.
    let a = assignButtonAndBlinds(draft.seats, lastBigBlindSeat);
    bbHistory.push(a.bbSeat);
    lastBigBlindSeat = a.bbSeat;

    // Orbit 2: same table, BB must advance to the very next occupied seat.
    const ringFull = occupiedRing(draft.seats);
    a = assignButtonAndBlinds(draft.seats, lastBigBlindSeat);
    expect(a.bbSeat).toBe(nextInRing(ringFull, lastBigBlindSeat));
    expect(a.bbSeat).not.toBe(lastBigBlindSeat);
    bbHistory.push(a.bbSeat);
    lastBigBlindSeat = a.bbSeat;

    // Orbit 3: seat 2 leaves (goes empty). BB must skip straight to the next
    // seat that's still occupied, never landing on the vacated seat, and
    // never repeating the previous BB.
    draft.seats[2]!.status = 'empty';
    const ringAfterLeave1 = occupiedRing(draft.seats);
    a = assignButtonAndBlinds(draft.seats, lastBigBlindSeat);
    expect(a.bbSeat).toBe(nextInRing(ringAfterLeave1, lastBigBlindSeat));
    expect(ringAfterLeave1).toContain(a.bbSeat);
    expect(a.bbSeat).not.toBe(lastBigBlindSeat);
    bbHistory.push(a.bbSeat);
    lastBigBlindSeat = a.bbSeat;

    // Orbit 4: seat 4 also leaves.
    draft.seats[4]!.status = 'empty';
    const ringAfterLeave2 = occupiedRing(draft.seats);
    a = assignButtonAndBlinds(draft.seats, lastBigBlindSeat);
    expect(a.bbSeat).toBe(nextInRing(ringAfterLeave2, lastBigBlindSeat));
    expect(ringAfterLeave2).toContain(a.bbSeat);
    expect(a.bbSeat).not.toBe(lastBigBlindSeat);
    bbHistory.push(a.bbSeat);
    lastBigBlindSeat = a.bbSeat;

    // Orbit 5: a new player joins in seat 2's old spot.
    draft.seats[2]!.status = 'active';
    draft.seats[2]!.stack = 500;
    const ringAfterJoin = occupiedRing(draft.seats);
    a = assignButtonAndBlinds(draft.seats, lastBigBlindSeat);
    expect(a.bbSeat).toBe(nextInRing(ringAfterJoin, lastBigBlindSeat));
    expect(ringAfterJoin).toContain(a.bbSeat);
    expect(a.bbSeat).not.toBe(lastBigBlindSeat);
    bbHistory.push(a.bbSeat);

    // No seat was ever BB in two consecutive orbits.
    for (let i = 1; i < bbHistory.length; i++) {
      expect(bbHistory[i]).not.toBe(bbHistory[i - 1]);
    }
  });

  it('heads-up: the button is always the small blind', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 1, playerId: 'A', stack: 500 },
      { seatId: 4, playerId: 'B', stack: 500 },
    ]);
    const draft = toDraft(t);
    const a = assignButtonAndBlinds(draft.seats, null);
    expect(a.headsUp).toBe(true);
    expect(a.buttonSeat).toBe(a.sbSeat);
    expect(a.buttonSeat).not.toBe(a.bbSeat);
  });
});
