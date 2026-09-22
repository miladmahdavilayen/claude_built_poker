export interface SeatPosition {
  seatId: number;
  left: number;
  top: number;
  /** Where this seat's current-street bet chips render — partway between the seat and the table's center, on the felt itself, not crammed into the seat's own info panel. */
  betLeft: number;
  betTop: number;
}

/** Position seats evenly around an oval table, with `bottomSeatId` (the viewer's own seat, or 0 for a spectator) placed at the bottom. */
export function seatPositions(seatCount: number, bottomSeatId: number): SeatPosition[] {
  const out: SeatPosition[] = [];
  for (let i = 0; i < seatCount; i++) {
    const seatId = (bottomSeatId + i) % seatCount;
    const theta = Math.PI / 2 + (i * 2 * Math.PI) / seatCount;
    const left = 50 + 44 * Math.cos(theta);
    const top = 50 + 40 * Math.sin(theta);
    const betLeft = 50 + 26 * Math.cos(theta);
    const betTop = 50 + 22 * Math.sin(theta);
    out.push({ seatId, left, top, betLeft, betTop });
  }
  return out;
}

/**
 * A table with fewer max seats has more room per seat to work with — a
 * heads-up (2-max) table gets noticeably larger seats, cards, avatars and
 * video tiles (`.seat-video` is sized as a percentage of `.seat`, so it
 * scales for free) than a full 9-max table crams in. Baseline (scale 1.0,
 * matching every size this CSS shipped with before per-seat-count scaling
 * existed) is 6-max, the lobby's own default table size — every other
 * seat count scales relative to that, so a 6-max table looks pixel-for-
 * pixel identical to before. Device-size responsiveness (phone vs.
 * desktop) is a SEPARATE, orthogonal axis handled entirely in CSS via
 * `--mobile-shrink` media queries multiplying `--seat-width`/`--seat-scale`
 * down further — this only ever accounts for player count.
 */
export function seatSizeVars(maxSeats: number): Record<string, string> {
  const scale = Math.min(1.45, Math.max(0.72, 1 + (6 - maxSeats) * 0.11));
  const px = (base: number, min: number): string => `${String(Math.max(min, Math.round(base * scale)))}px`;
  return {
    '--seat-width': px(128, 76),
    '--seat-pad': px(6, 4),
    '--seat-gap': px(4, 3),
    '--card-w': px(30, 22),
    '--card-h': px(44, 32),
    '--card-font': px(13, 11),
    '--avatar-size': px(16, 13),
    '--avatar-font': px(10, 8),
    '--seat-name-font': px(12, 10),
    '--dealer-size': px(20, 16),
    '--pos-label-font': px(9, 8),
    '--bubble-font': px(11, 9),
  };
}
