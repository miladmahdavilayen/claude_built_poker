import { assignButtonAndBlinds } from './button.js';
import { isValidDeck } from './deck.js';
import { dealHoleCards } from './streets.js';
import type { Draft, MutableSeat } from './table.js';
import { nextInRing, occupiedRing, requireSeat } from './table.js';
import type { BlindPost, Card, EngineError, GameEvent } from './types.js';

export type PrepareHandResult = { ok: true; events: GameEvent[] } | { ok: false; error: EngineError };

function resetSeatForNewHand(seat: MutableSeat): void {
  if (seat.status === 'folded' || seat.status === 'all-in') {
    seat.status = seat.stack > 0 ? 'active' : 'sitting-out';
  }
  seat.holeCards = [];
  seat.committedThisStreet = 0;
  seat.committedThisHand = 0;
  seat.hasActedThisRound = false;
  seat.isAllowedToRaise = true;
  seat.lastActedAtBet = 0;
}

export function prepareAndDealHand(draft: Draft, deck: readonly Card[]): PrepareHandResult {
  if (draft.phase === 'in-hand') {
    return { ok: false, error: { code: 'HAND_ALREADY_IN_PROGRESS', message: 'A hand is already in progress.' } };
  }
  if (!isValidDeck(deck)) {
    return { ok: false, error: { code: 'INVALID_DECK', message: 'Deck must contain exactly the 52 standard cards, each once.' } };
  }

  for (const seat of draft.seats) resetSeatForNewHand(seat);

  const dealtIn = draft.seats.filter((s) => s.status === 'active' && s.stack > 0);
  if (dealtIn.length < 2) {
    return { ok: false, error: { code: 'NOT_ENOUGH_PLAYERS', message: 'At least 2 seats with chips are required to start a hand.' } };
  }

  const assignment = assignButtonAndBlinds(draft.seats, draft.lastBigBlindSeat);
  draft.buttonSeat = assignment.buttonSeat;
  draft.deck = [...deck];
  draft.board = [];
  draft.burned = [];
  draft.pots = [];
  draft.street = 'preflop';
  draft.allInRevealed = false;
  draft.anteTotal = 0;
  draft.handNumber += 1;

  const events: GameEvent[] = [
    { type: 'hand-started', handNumber: draft.handNumber, buttonSeat: draft.buttonSeat, smallBlindSeat: assignment.sbSeat, bigBlindSeat: assignment.bbSeat },
  ];

  if (draft.config.ante > 0) {
    const bbSeat = requireSeat(draft.seats, assignment.bbSeat);
    const anteAmount = Math.min(draft.config.ante, bbSeat.stack);
    bbSeat.stack -= anteAmount;
    draft.anteTotal += anteAmount;
    events.push({ type: 'ante-posted', posts: [{ seatId: bbSeat.seatId, amount: anteAmount }] });
  }

  const posts: BlindPost[] = [];

  const sbSeat = requireSeat(draft.seats, assignment.sbSeat);
  const sbAmount = Math.min(draft.config.smallBlind, sbSeat.stack);
  sbSeat.stack -= sbAmount;
  sbSeat.committedThisStreet += sbAmount;
  sbSeat.committedThisHand += sbAmount;
  sbSeat.missedSmallBlind = false;
  if (sbSeat.stack === 0) sbSeat.status = 'all-in';
  posts.push({ seatId: sbSeat.seatId, kind: 'small-blind', amount: sbAmount, allIn: sbSeat.status === 'all-in' });

  const bbSeatForBlind = requireSeat(draft.seats, assignment.bbSeat);
  const bbAmount = Math.min(draft.config.bigBlind, bbSeatForBlind.stack);
  bbSeatForBlind.stack -= bbAmount;
  bbSeatForBlind.committedThisStreet += bbAmount;
  bbSeatForBlind.committedThisHand += bbAmount;
  bbSeatForBlind.missedBigBlind = false;
  if (bbSeatForBlind.stack === 0) bbSeatForBlind.status = 'all-in';
  posts.push({ seatId: bbSeatForBlind.seatId, kind: 'big-blind', amount: bbAmount, allIn: bbSeatForBlind.status === 'all-in' });

  // currentBet (what must be called) must reflect what was actually
  // posted, not the nominal config amount — a short-stacked SB or BB
  // posting all-in for less still means that reduced amount is the real
  // amount owed. lastFullRaiseIncrement stays anchored to the table's
  // nominal big blind regardless (a short forced post, unlike a short
  // voluntary bet, doesn't shrink the minimum raise structure). See
  // DECISIONS.md.
  const openingBet = Math.max(sbAmount, bbAmount);
  draft.betting.currentBet = openingBet;
  draft.betting.lastFullRaiseIncrement = draft.config.bigBlind;
  draft.betting.lastFullBetAmount = openingBet;
  draft.betting.lastAggressorSeat = assignment.bbSeat;

  let straddleSeat: number | null = null;
  if (draft.config.straddleEnabled && !assignment.headsUp) {
    const ring = occupiedRing(draft.seats).filter((id) => {
      const s = requireSeat(draft.seats, id);
      return s.status === 'active' || s.status === 'all-in';
    });
    if (ring.includes(assignment.bbSeat)) {
      const utgCandidate = nextInRing(ring, assignment.bbSeat);
      const utgSeat = requireSeat(draft.seats, utgCandidate);
      if (utgSeat.status === 'active' && utgSeat.stack > 0) {
        const straddleAmount = Math.min(draft.config.bigBlind * 2, utgSeat.stack + utgSeat.committedThisStreet);
        const delta = straddleAmount - utgSeat.committedThisStreet;
        utgSeat.stack -= delta;
        utgSeat.committedThisStreet = straddleAmount;
        utgSeat.committedThisHand += delta;
        if (utgSeat.stack === 0) utgSeat.status = 'all-in';
        straddleSeat = utgSeat.seatId;
        // A short-stacked UTG's all-in straddle can be less than the BB
        // already posted (openingBet) — that's a forced short call, not a
        // raise, and must not lower currentBet or reassign the
        // aggressor. Only a straddle that actually exceeds openingBet
        // becomes the new effective opening bet. Same fix as
        // openingBet/currentBet above, for the same reason.
        if (straddleAmount > draft.betting.currentBet) {
          draft.betting.currentBet = straddleAmount;
          draft.betting.lastFullRaiseIncrement = straddleAmount;
          draft.betting.lastFullBetAmount = straddleAmount;
          draft.betting.lastAggressorSeat = straddleSeat;
        }
        posts.push({ seatId: straddleSeat, kind: 'straddle', amount: straddleAmount, allIn: utgSeat.status === 'all-in' });
      }
    }
  }
  draft.straddleSeat = straddleSeat;

  events.push({ type: 'blinds-posted', posts });

  draft.lastBigBlindSeat = assignment.bbSeat;

  const dealOrder: number[] = [];
  const dealRing = occupiedRing(draft.seats).filter((id) => requireSeat(draft.seats, id).status === 'active' || requireSeat(draft.seats, id).status === 'all-in');
  let cursor = assignment.sbSeat;
  if (!dealRing.includes(cursor)) cursor = nextInRing(dealRing, cursor);
  for (let i = 0; i < dealRing.length; i++) {
    dealOrder.push(cursor);
    cursor = nextInRing(dealRing, cursor);
  }
  events.push(...dealHoleCards(draft, dealOrder));

  draft.phase = 'in-hand';
  draft.betting.actingSeat = straddleSeat ?? assignment.bbSeat;

  return { ok: true, events };
}
