import type { ProjectedSeat } from '@pokerclause/shared';

/**
 * Position names by table size, in seat order starting from the button
 * (index 0 = BTN) and walking forward through the action order (index 1
 * = SB, index 2 = BB, index 3 = UTG — first to act post-flop... no, first
 * to act PRE-flop — through to the seat directly before the button,
 * conventionally CO). Each row is its own hand-picked list rather than a
 * mechanical slice of the 9-max row, because real table-size naming
 * genuinely isn't a strict subset — e.g. 6-max conventionally uses UTG,
 * HJ, CO (skipping MP and UTG+1/2 entirely), not just "the last 3 of the
 * 9-max list". Sourced from the naming widely used by poker training
 * sites (e.g. Upswing Poker) for each table size.
 */
const POSITION_NAMES_BY_SIZE: Readonly<Record<number, readonly string[]>> = {
  2: ['BTN', 'BB'], // heads-up: the button is also the small blind
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'CO'],
  5: ['BTN', 'SB', 'BB', 'HJ', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'],
};

/**
 * Maps each seat currently dealt into the hand (or, between hands, still
 * occupied and not sitting out) to a position label, walking seat ids in
 * order starting from the button — the same "compacted ring of occupied
 * seats" model the engine itself uses for button/blind assignment (see
 * `packages/engine/src/button.ts`'s `dealtInRing`), so the labels always
 * agree with where the actual button and blinds landed.
 */
/**
 * The small and big blind of the hand being played — for the little SB/BB
 * tags in front of those seats. Only with three or more players: heads-up,
 * the button is the small blind, and two seats need no tags.
 */
export function blindTags(seats: readonly ProjectedSeat[], buttonSeat: number, inHand: boolean): ReadonlyMap<number, 'SB' | 'BB'> {
  const tags = new Map<number, 'SB' | 'BB'>();
  if (!inHand) return tags;
  const labels = computePositionLabels(seats, buttonSeat);
  if (labels.size <= 2) return tags;
  for (const [seatId, label] of labels) if (label === 'SB' || label === 'BB') tags.set(seatId, label);
  return tags;
}

export function computePositionLabels(seats: readonly ProjectedSeat[], buttonSeat: number): ReadonlyMap<number, string> {
  const ring = seats
    .filter((s) => s.status === 'active' || s.status === 'folded' || s.status === 'all-in')
    .map((s) => s.seatId)
    .sort((a, b) => a - b);

  const labels = new Map<number, string>();
  if (ring.length < 2 || !ring.includes(buttonSeat)) return labels;

  const names = POSITION_NAMES_BY_SIZE[ring.length] ?? POSITION_NAMES_BY_SIZE[9]!;
  const buttonIndex = ring.indexOf(buttonSeat);
  for (let i = 0; i < ring.length; i++) {
    const seatId = ring[(buttonIndex + i) % ring.length]!;
    labels.set(seatId, names[i] ?? '');
  }
  return labels;
}
