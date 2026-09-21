import type { EvaluatedHand, HandEvaluator } from './evaluator.js';
import { buildPots, returnUncalledBet } from './pots.js';
import type { Draft } from './table.js';
import { contendingSeatIds, nextInRing, requireSeat } from './table.js';
import type { GameEvent, ShowdownWinner } from './types.js';

function revealOrder(draft: Draft): number[] {
  const contenders = [...contendingSeatIds(draft.seats)].sort((a, b) => a - b);
  if (contenders.length === 0) return [];
  let first: number;
  if (draft.betting.lastAggressorSeat !== null && contenders.includes(draft.betting.lastAggressorSeat)) {
    first = draft.betting.lastAggressorSeat;
  } else {
    first = nextInRing(contenders, draft.buttonSeat);
  }
  const order: number[] = [];
  let cursor = first;
  for (let i = 0; i < contenders.length; i++) {
    order.push(cursor);
    cursor = nextInRing(contenders, cursor);
  }
  return order;
}

function oddChipDistance(seatId: number, buttonSeat: number, maxSeats: number): number {
  return ((seatId - buttonSeat - 1) % maxSeats + maxSeats) % maxSeats;
}

/** Everyone but one player has folded: sole survivor takes every pot layer, no evaluation needed. */
export function awardFoldWin(draft: Draft, winnerSeatId: number): GameEvent[] {
  const events: GameEvent[] = [];
  events.push(...returnUncalledBet(draft));
  events.push(...buildPots(draft));
  const winner = requireSeat(draft.seats, winnerSeatId);
  // Side pots (higher index) before the main pot, same ordering rule as runShowdown.
  for (let i = draft.pots.length - 1; i >= 0; i--) {
    const pot = draft.pots[i]!;
    winner.stack += pot.amount;
    const winners: ShowdownWinner[] = [{ seatId: winnerSeatId, amount: pot.amount }];
    events.push({ type: 'pot-awarded', potIndex: pot.index, winners });
  }
  return events;
}

/** Two or more non-folded players reach showdown: evaluate best-5-of-7 per pot and award. */
export function runShowdown(draft: Draft, evaluator: HandEvaluator): GameEvent[] {
  const events: GameEvent[] = [];
  events.push(...returnUncalledBet(draft));
  events.push(...buildPots(draft));

  const contenders = contendingSeatIds(draft.seats);
  if (!draft.allInRevealed) {
    for (const seatId of revealOrder(draft)) {
      const seat = requireSeat(draft.seats, seatId);
      events.push({ type: 'showdown-reveal', seatId, holeCards: [...seat.holeCards] });
    }
  }

  const evaluations = new Map<number, EvaluatedHand>();
  for (const seatId of contenders) {
    const seat = requireSeat(draft.seats, seatId);
    evaluations.set(seatId, evaluator.evaluate([...draft.board, ...seat.holeCards]));
  }

  for (let i = draft.pots.length - 1; i >= 0; i--) {
    const pot = draft.pots[i]!;
    let bestValue = Number.POSITIVE_INFINITY;
    for (const seatId of pot.eligibleSeatIds) {
      const value = evaluations.get(seatId)!.value;
      if (value < bestValue) bestValue = value;
    }
    const winnerSeatIds = pot.eligibleSeatIds.filter((id) => evaluations.get(id)!.value === bestValue);
    const n = winnerSeatIds.length;
    const share = Math.floor(pot.amount / n);
    const remainder = pot.amount - share * n;

    const oddChipOrder = [...winnerSeatIds].sort(
      (a, b) => oddChipDistance(a, draft.buttonSeat, draft.config.maxSeats) - oddChipDistance(b, draft.buttonSeat, draft.config.maxSeats),
    );
    const extra = new Map<number, number>();
    for (let k = 0; k < remainder; k++) {
      const seatId = oddChipOrder[k]!;
      extra.set(seatId, (extra.get(seatId) ?? 0) + 1);
    }

    const winners: ShowdownWinner[] = [];
    for (const seatId of winnerSeatIds) {
      const seat = requireSeat(draft.seats, seatId);
      const amount = share + (extra.get(seatId) ?? 0);
      seat.stack += amount;
      const evaluated = evaluations.get(seatId)!;
      winners.push({ seatId, amount, handName: evaluated.name, bestFive: evaluated.bestFive });
    }
    events.push({ type: 'pot-awarded', potIndex: pot.index, winners });
  }

  return events;
}
