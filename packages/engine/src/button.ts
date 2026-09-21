import type { MutableSeat } from './table.js';
import { nextInRing, prevInRing } from './table.js';

export interface ButtonAssignment {
  buttonSeat: number;
  /** null only in heads-up-is-impossible edge cases; otherwise always a live seat (see DECISIONS.md). */
  sbSeat: number;
  bbSeat: number;
  headsUp: boolean;
}

/**
 * Seats that will actually be dealt into this hand: occupied AND not
 * sitting out. A sitting-out seat is skipped for button/blind rotation
 * purposes exactly like an empty one — it must never be assigned SB/BB
 * (it won't be dealt cards or included in the action order, so forcing a
 * blind post on it would corrupt pot eligibility at showdown). This is
 * distinct from `occupiedRing` (used for physical-seat bookkeeping); see
 * DECISIONS.md.
 */
function dealtInRing(seats: readonly MutableSeat[]): number[] {
  return seats
    .filter((s) => s.status === 'active' && s.stack > 0)
    .map((s) => s.seatId)
    .sort((a, b) => a - b);
}

/**
 * Moving-button algorithm. The big blind always advances to the very
 * next occupied seat (never skips one, never repeats one) relative to
 * last hand's big blind. Small blind and button are the two occupied
 * seats immediately preceding it in seating order. In heads-up, the
 * button is the small blind.
 *
 * See DECISIONS.md for why this "compacted occupied-seat ring" model
 * was chosen over literally parking the button/SB marker on a vacant
 * physical seat.
 */
export function assignButtonAndBlinds(
  seats: readonly MutableSeat[],
  lastBigBlindSeat: number | null,
): ButtonAssignment {
  const ring = dealtInRing(seats);
  if (ring.length < 2) {
    throw new Error('unreachable: assignButtonAndBlinds requires >= 2 occupied seats');
  }

  if (lastBigBlindSeat === null) {
    const button = ring[0]!;
    if (ring.length === 2) {
      return { buttonSeat: button, sbSeat: button, bbSeat: nextInRing(ring, button), headsUp: true };
    }
    const sb = nextInRing(ring, button);
    const bb = nextInRing(ring, sb);
    return { buttonSeat: button, sbSeat: sb, bbSeat: bb, headsUp: false };
  }

  const bb = nextInRing(ring, lastBigBlindSeat);
  if (ring.length === 2) {
    const other = nextInRing(ring, bb);
    return { buttonSeat: other, sbSeat: other, bbSeat: bb, headsUp: true };
  }
  const sb = prevInRing(ring, bb);
  const button = prevInRing(ring, sb);
  return { buttonSeat: button, sbSeat: sb, bbSeat: bb, headsUp: false };
}
