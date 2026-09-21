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
