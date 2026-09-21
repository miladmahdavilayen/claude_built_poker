import { describe, expect, it } from 'vitest';
import { applyAction, getLegalActions, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectErr, expectOk, orderedDeck } from '../helpers.js';

describe('preflop basics', () => {
  it('scenario 2: 6-max preflop order (UTG first); BB gets the option on a limped pot', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, straddleEnabled: false };
    const t = createTableState(
      config,
      [0, 1, 2, 3, 4, 5].map((seatId) => ({ seatId, playerId: `P${String(seatId)}`, stack: 500 })),
    );
    const deck = orderedDeck('2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c', 'Tc', 'Jc', 'Qc', 'Kc');
    const started = expectOk(startHand(t, deck));

    // button=0, sb=1, bb=2; order: UTG(3) -> MP(4) -> CO(5) -> BTN(0) -> SB(1) -> BB(2).
    expect(started.betting.actingSeat).toBe(3);

    let s = expectOk(applyAction(started, { seatId: 3, type: 'call' }));
    s = expectOk(applyAction(s, { seatId: 4, type: 'call' }));
    s = expectOk(applyAction(s, { seatId: 5, type: 'call' }));
    s = expectOk(applyAction(s, { seatId: 0, type: 'call' }));
    s = expectOk(applyAction(s, { seatId: 1, type: 'call' }));

    // Everyone has limped in for the big blind; the pot is not closed until BB acts.
    expect(s.betting.actingSeat).toBe(2);
    const bbLegal = getLegalActions(s, 2);
    expect(bbLegal.canCheck).toBe(true);
    expect(bbLegal.canRaise).toBe(true);

    const afterCheck = expectOk(applyAction(s, { seatId: 2, type: 'check' }));
    expect(afterCheck.street).toBe('flop');
  });

  it('scenario 13: min-raise chain 2 -> 4 -> 6 -> 10 legal; a raise to 5 is rejected', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 500 },
    ]);
    const deck = orderedDeck('2c', '3c', '4c', '5c', '6c', '7c');
    const started = expectOk(startHand(t, deck));
    // 3-handed: button=0, sb=1, bb=2; order: BTN(0) -> SB(1) -> BB(2).
    expect(started.betting.actingSeat).toBe(0);

    const s1 = expectOk(applyAction(started, { seatId: 0, type: 'raise', amountTo: 4 }));

    const rejected = applyAction(s1, { seatId: 1, type: 'raise', amountTo: 5 });
    expect(expectErr(rejected)).toBe('ILLEGAL_AMOUNT');

    const s2 = expectOk(applyAction(s1, { seatId: 1, type: 'raise', amountTo: 6 }));
    const s3 = expectOk(applyAction(s2, { seatId: 2, type: 'raise', amountTo: 10 }));
    expect(s3.betting.currentBet).toBe(10);
  });

  it('scenario 14: a player all-in for less than the blind posts what they have', () => {
    const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 3, straddleEnabled: false };
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 500 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 1 },
    ]);
    const deck = orderedDeck('2c', '3c', '4c', '5c', '6c');
    const started = expectOk(startHand(t, deck));

    const bb = started.seats[2]!;
    expect(bb.stack).toBe(0);
    expect(bb.status).toBe('all-in');
    expect(bb.committedThisStreet).toBe(1);
    expect(bb.committedThisHand).toBe(1);
  });
});
