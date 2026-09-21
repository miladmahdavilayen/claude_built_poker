import type { BettingState, Card, Pot, SeatState, Street, TableConfig, TableState } from './types.js';

export type MutableSeat = Omit<SeatState, 'holeCards'> & { holeCards: Card[] };

export interface Draft {
  handNumber: number;
  config: TableConfig;
  seats: MutableSeat[];
  buttonSeat: number;
  street: Street;
  board: Card[];
  burned: Card[];
  deck: Card[];
  betting: { -readonly [K in keyof BettingState]: BettingState[K] };
  pots: Pot[];
  phase: TableState['phase'];
  actionSeq: number;
  lastBigBlindSeat: number | null;
  straddleSeat: number | null;
  allInRevealed: boolean;
  anteTotal: number;
}

export function toDraft(state: TableState): Draft {
  return {
    handNumber: state.handNumber,
    config: state.config,
    seats: state.seats.map((s) => ({ ...s, holeCards: [...s.holeCards] })),
    buttonSeat: state.buttonSeat,
    street: state.street,
    board: [...state.board],
    burned: [...state.burned],
    deck: [...state.deck],
    betting: { ...state.betting },
    pots: state.pots.map((p) => ({ ...p, eligibleSeatIds: [...p.eligibleSeatIds] })),
    phase: state.phase,
    actionSeq: state.actionSeq,
    lastBigBlindSeat: state.lastBigBlindSeat,
    straddleSeat: state.straddleSeat,
    allInRevealed: state.allInRevealed,
    anteTotal: state.anteTotal,
  };
}

export function fromDraft(draft: Draft): TableState {
  return {
    handNumber: draft.handNumber,
    config: draft.config,
    seats: draft.seats.map((s) => ({ ...s, holeCards: [...s.holeCards] })),
    buttonSeat: draft.buttonSeat,
    street: draft.street,
    board: [...draft.board],
    burned: [...draft.burned],
    deck: [...draft.deck],
    betting: { ...draft.betting },
    pots: draft.pots.map((p) => ({ ...p, eligibleSeatIds: [...p.eligibleSeatIds] })),
    phase: draft.phase,
    actionSeq: draft.actionSeq,
    lastBigBlindSeat: draft.lastBigBlindSeat,
    straddleSeat: draft.straddleSeat,
    allInRevealed: draft.allInRevealed,
    anteTotal: draft.anteTotal,
  };
}

export function getSeat(seats: readonly MutableSeat[], seatId: number): MutableSeat | undefined {
  return seats.find((s) => s.seatId === seatId);
}

export function requireSeat(seats: readonly MutableSeat[], seatId: number): MutableSeat {
  const seat = getSeat(seats, seatId);
  if (!seat) throw new Error(`unreachable: unknown seatId ${seatId}`);
  return seat;
}

/** Seats currently occupied by a player (any status but 'empty'), ascending by seatId. */
export function occupiedRing(seats: readonly MutableSeat[]): number[] {
  return seats
    .filter((s) => s.status !== 'empty')
    .map((s) => s.seatId)
    .sort((a, b) => a - b);
}

/** Seats dealt into the current hand (active, folded, or all-in). */
export function dealtInSeatIds(seats: readonly MutableSeat[]): number[] {
  return seats
    .filter((s) => s.status === 'active' || s.status === 'folded' || s.status === 'all-in')
    .map((s) => s.seatId);
}

/** Seats still contesting the pot (not folded) among those dealt in. */
export function contendingSeatIds(seats: readonly MutableSeat[]): number[] {
  return seats
    .filter((s) => s.status === 'active' || s.status === 'all-in')
    .map((s) => s.seatId);
}

export function nextInRing(ring: readonly number[], from: number): number {
  if (ring.length === 0) throw new Error('unreachable: empty ring');
  const idx = ring.indexOf(from);
  if (idx === -1) {
    const greater = ring.find((s) => s > from);
    return greater ?? ring[0]!;
  }
  return ring[(idx + 1) % ring.length]!;
}

export function prevInRing(ring: readonly number[], from: number): number {
  if (ring.length === 0) throw new Error('unreachable: empty ring');
  const idx = ring.indexOf(from);
  if (idx === -1) {
    const reversed = [...ring].reverse();
    const smaller = reversed.find((s) => s < from);
    return smaller ?? reversed[0]!;
  }
  return ring[(idx - 1 + ring.length) % ring.length]!;
}

/** Next seat clockwise from `from` (exclusive) whose seatId is in `pending`. */
export function nextPending(seats: readonly MutableSeat[], from: number, pending: ReadonlySet<number>): number {
  const ring = seats.map((s) => s.seatId).sort((a, b) => a - b);
  let cursor = from;
  for (let i = 0; i < ring.length; i++) {
    cursor = nextInRing(ring, cursor);
    if (pending.has(cursor)) return cursor;
  }
  throw new Error('unreachable: pending set non-empty but no matching seat found in ring');
}
