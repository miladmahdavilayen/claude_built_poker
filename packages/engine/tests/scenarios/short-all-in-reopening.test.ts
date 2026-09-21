import { describe, expect, it } from 'vitest';
import { applyAction, getLegalActions, startHand } from '../../src/engine.js';
import { createTableState } from '../../src/factory.js';
import { expectOk, orderedDeck } from '../helpers.js';

// 5-max table, blinds 1/2. First hand: button=0, SB=1, BB=2.
// Preflop order: UTG(3) -> UTG1(4) -> BTN(0) -> SB(1) -> BB(2).
//
// This reproduces the spec's canonical numbers (blinds 1/2, bet 10, raise
// to 25, short all-in for 30 => a seat facing only the short all-in owes
// 5 more and cannot re-raise; a seat that hasn't acted yet can raise, to
// 40). To land on those exact figures a seat must have already CALLED
// the full raise to 25 before the short all-in lands (that's what makes
// its facing amount exactly 5) — so BTN plays the role of "A" here.
const config = { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 5, straddleEnabled: false };

function table() {
  return createTableState(config, [
    { seatId: 0, playerId: 'BTN', stack: 500 },
    { seatId: 1, playerId: 'SB', stack: 30 },
    { seatId: 2, playerId: 'BB', stack: 500 },
    { seatId: 3, playerId: 'UTG', stack: 500 },
    { seatId: 4, playerId: 'UTG1', stack: 500 },
  ]);
}

function playToShortAllIn() {
  const deck = orderedDeck('2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c', 'Tc', 'Jc');
  const started = expectOk(startHand(table(), deck));
  const s1 = expectOk(applyAction(started, { seatId: 3, type: 'raise', amountTo: 10 })); // UTG opens to 10
  const s2 = expectOk(applyAction(s1, { seatId: 4, type: 'raise', amountTo: 25 })); // UTG1 raises to 25 (full: +15 >= 8)
  const s3 = expectOk(applyAction(s2, { seatId: 0, type: 'call' })); // BTN calls 25
  const s4 = expectOk(applyAction(s3, { seatId: 1, type: 'raise', amountTo: 30 })); // SB all-in for 30 (short: +5 < 15)
  return s4;
}

describe('short all-in reopening', () => {
  it('scenario 3: a short all-in does not reopen action for a seat that already acted', () => {
    const s4 = playToShortAllIn();
    expect(s4.seats[1]!.status).toBe('all-in');

    // BTN already called the full raise (to 25) and does not face a full
    // raise from SB's short all-in: cannot re-raise, can only call the extra 5.
    const legalBtn = getLegalActions(s4, 0);
    expect(legalBtn.canRaise).toBe(false);
    expect(legalBtn.canCall).toBe(true);
    expect(legalBtn.callAmount).toBe(5);
  });

  it('scenario 4: a seat that has not yet acted can still raise, from the last full raise', () => {
    const s4 = playToShortAllIn();

    // BB has not acted yet this round (only posted the blind).
    expect(s4.betting.actingSeat).toBe(2);
    const legalBb = getLegalActions(s4, 2);
    expect(legalBb.canRaise).toBe(true);
    expect(legalBb.minRaiseTo).toBe(40);
  });

  it('scenario 5: cumulative short all-ins reopen action, min raise measured from the last full raise', () => {
    const t = createTableState(config, [
      { seatId: 0, playerId: 'BTN', stack: 40 },
      { seatId: 1, playerId: 'SB', stack: 500 },
      { seatId: 2, playerId: 'BB', stack: 500 },
      { seatId: 3, playerId: 'UTG', stack: 500 },
      { seatId: 4, playerId: 'UTG1', stack: 25 },
    ]);
    const deck = orderedDeck('2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c', 'Tc', 'Jc');
    const started = expectOk(startHand(t, deck)); // button=0,sb=1,bb=2; order: UTG(3)->UTG1(4)->BTN(0)->SB(1)->BB(2)

    // UTG raises to 20: full raise (increment 18 over BB's 2). lastFullRaiseIncrement=18, anchor=20.
    const s1 = expectOk(applyAction(started, { seatId: 3, type: 'raise', amountTo: 20 }));
    expect(s1.betting.lastFullRaiseIncrement).toBe(18);

    // UTG1 is all-in for 25: a short raise (+5, well under the 18 required). Does not reopen UTG alone.
    const s2 = expectOk(applyAction(s1, { seatId: 4, type: 'raise', amountTo: 25 }));
    const legalAfterFirstShort = getLegalActions(s2, 3);
    expect(legalAfterFirstShort.canRaise).toBe(false);
    expect(legalAfterFirstShort.canCall).toBe(true);
    expect(legalAfterFirstShort.callAmount).toBe(5);

    // BTN is all-in for 40: another short raise individually (+15 over 25, still < 18),
    // but the COMBINED growth since UTG last acted (20) is now 40-20=20 >= 18: reopened.
    const s3 = expectOk(applyAction(s2, { seatId: 0, type: 'raise', amountTo: 40 }));
    const legalUtg = getLegalActions(s3, 3);
    expect(legalUtg.canRaise).toBe(true);
    // Anchored to the last full raise (20+18=38), floored to strictly exceed the 40 owed.
    expect(legalUtg.minRaiseTo).toBe(41);
  });
});
