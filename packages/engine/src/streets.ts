import type { Draft } from './table.js';
import { requireSeat } from './table.js';
import type { Card, GameEvent } from './types.js';

export function resetBettingForNewStreet(draft: Draft): void {
  draft.betting.currentBet = 0;
  draft.betting.lastFullRaiseIncrement = draft.config.bigBlind;
  draft.betting.lastFullBetAmount = 0;
  draft.betting.lastAggressorSeat = null;
  draft.betting.actingSeat = null;
  for (const seat of draft.seats) {
    seat.committedThisStreet = 0;
    seat.lastActedAtBet = 0;
    if (seat.status === 'active') {
      seat.hasActedThisRound = false;
      seat.isAllowedToRaise = true;
    }
  }
}

function draw(draft: Draft): Card {
  const card = draft.deck.shift();
  if (card === undefined) throw new Error('unreachable: deck exhausted');
  return card;
}

export function dealHoleCards(draft: Draft, order: readonly number[]): GameEvent[] {
  const hands = new Map<number, Card[]>();
  for (const seatId of order) hands.set(seatId, []);
  for (let round = 0; round < 2; round++) {
    for (const seatId of order) {
      hands.get(seatId)!.push(draw(draft));
    }
  }
  for (const seatId of order) {
    requireSeat(draft.seats, seatId).holeCards = hands.get(seatId)!;
  }
  return [{ type: 'cards-dealt', deals: order.map((seatId) => ({ seatId, cards: hands.get(seatId)! })) }];
}

function dealCommunity(draft: Draft, street: 'flop' | 'turn' | 'river', count: number): GameEvent[] {
  const burned = draw(draft);
  draft.burned.push(burned);
  for (let i = 0; i < count; i++) draft.board.push(draw(draft));
  draft.street = street;
  resetBettingForNewStreet(draft);
  return [{ type: 'street-dealt', street, board: [...draft.board], burned }];
}

export function dealFlop(draft: Draft): GameEvent[] {
  return dealCommunity(draft, 'flop', 3);
}

export function dealTurn(draft: Draft): GameEvent[] {
  return dealCommunity(draft, 'turn', 1);
}

export function dealRiver(draft: Draft): GameEvent[] {
  return dealCommunity(draft, 'river', 1);
}
