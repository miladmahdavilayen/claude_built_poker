// Where everything sits on the 3D table — as data, so spacing can be tuned
// here without touching the scene code.
//
// Coordinates: the table's center is the origin, Y is up, the felt is the
// plane y = 0. Seen from above with the HOUSE DEALER at the bottom (the
// reference map), +X is right and +Z is toward the house dealer. The house
// dealer stands at the exact center of that near long edge and never moves.
//
// A seat's place is a fraction `s` of the way around the table's rounded-
// rectangle edge, measured from the house dealer's spot and running
// clockwise as seen from above: along the dealer's edge to the left, up the
// left short end, across the far long edge, down the right short end and
// back along the dealer's edge. Seat numbers (seatId + 1, as everywhere in
// the app) follow that same clockwise order on every client — the camera is
// the only thing that changes from one viewer to the next.

/** The table's outer edge (the rail's outside): half-width along X, half-depth along Z, corner radius. */
export const TABLE = {
  halfWidth: 3.3,
  halfDepth: 1.75,
  cornerRadius: 1.25,
  /** How wide the padded rail is, from the outer edge in to the felt. */
  railWidth: 0.3,
  railHeight: 0.13,
} as const;

/**
 * Each table size's seat fractions, seat 1 first. The 9-seat table is the
 * reference map: seat 1 just left of the house dealer on the dealer's
 * edge, seats 2–3 on the left end, 4–6 across the far edge, 7–8 on the
 * right end and seat 9 just right of the house dealer. Smaller tables
 * spread their seats over the same edge, keeping the dealer's spot clear.
 */
export const SEAT_FRACTIONS: Record<number, readonly number[]> = {
  // Heads-up: one at the middle of each short end, face to face across the felt.
  2: [0.25, 0.75],
  3: [0.27, 0.5, 0.73],
  4: [0.2, 0.4, 0.6, 0.8],
  5: [0.16, 0.33, 0.5, 0.67, 0.84],
  6: [0.1, 0.26, 0.42, 0.58, 0.74, 0.9],
  7: [0.1, 0.23, 0.365, 0.5, 0.635, 0.77, 0.9],
  8: [0.1, 0.215, 0.33, 0.445, 0.555, 0.67, 0.785, 0.9],
  9: [0.1, 0.205, 0.3, 0.415, 0.5, 0.585, 0.7, 0.795, 0.9],
};

/** How far out from the rail a seat's chair stands, and the spots on the felt in front of it (distances in from the rail's inner edge). */
export const SEAT_SPOTS = {
  chairOut: 0.55,
  /** The player's two hole cards, face down. */
  cardsIn: 0.32,
  /** Their current-street bet. */
  betIn: 0.92,
  /**
   * The dealer button (and the SB/BB tag), when it's theirs: straight in
   * front of the player, just past their cards and a touch to their right —
   * close enough that from any seat it plainly belongs to them.
   */
  buttonIn: 0.6,
  buttonSide: 0.22,
  /**
   * Your own button: right beside your own cards — which lie further in and
   * bigger than anyone else's (cards3d's OWN_IN) — on your right, so it's in
   * view whenever they are. (Your button or blind is also on your own box,
   * just below them — see Seat's ownMark.)
   */
  ownMarkIn: 0.54,
  ownMarkSide: 0.58,
  /** Where the seat's box (video, name, stack) is anchored: above the chair, at a seated player's chest height. */
  overlayHeight: 0.75,
} as const;

/** The house dealer, the chip tray in front of them, the board and the pot. */
export const HOUSE = {
  /** The house dealer's spot: centered on the near long edge, just outside the rail. */
  dealerZ: TABLE.halfDepth + 0.42,
  trayWidth: 1.5,
  trayDepth: 0.26,
  /** The board's five cards, in the middle of the felt, in a row parallel to the house dealer's edge. */
  boardZ: -0.05,
  boardSpacing: 0.45,
  /** The pot, between the board and the house dealer. */
  potZ: 0.62,
  /** The muck and burn pile, by the house dealer's right hand. */
  muckX: 0.5,
  muckZ: TABLE.halfDepth - 0.68,
} as const;

export interface EdgePoint {
  x: number;
  z: number;
  /** Outward unit normal (away from the table's center). */
  nx: number;
  nz: number;
}

/**
 * The point `s` (0–1) of the way clockwise around the table's edge from
 * the house dealer's spot, `inset` in from the outer edge (negative to go
 * outside it), with its outward normal.
 */
export function edgePoint(s: number, inset = 0): EdgePoint {
  const w = TABLE.halfWidth - inset;
  const d = TABLE.halfDepth - inset;
  const r = Math.max(0.05, TABLE.cornerRadius - inset);
  const straightX = w - r; // half-length of each long edge's straight part
  const straightZ = d - r; // half-length of each short end's straight part
  const arc = (Math.PI / 2) * r;
  // Segments clockwise from the bottom center: bottom-left half, bottom-left
  // corner, left side, top-left corner, top, top-right corner, right side,
  // bottom-right corner, bottom-right half.
  const lengths = [straightX, arc, 2 * straightZ, arc, 2 * straightX, arc, 2 * straightZ, arc, straightX];
  const total = lengths.reduce((a, b) => a + b, 0);
  let t = (((s % 1) + 1) % 1) * total;
  let seg = 0;
  while (seg < lengths.length - 1 && t > lengths[seg]!) {
    t -= lengths[seg]!;
    seg++;
  }
  const corner = (cx: number, cz: number, startAngle: number): EdgePoint => {
    // Clockwise on screen (+Z down) is increasing angle in X/Z.
    const a = startAngle + t / r;
    return { x: cx + r * Math.cos(a), z: cz + r * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) };
  };
  switch (seg) {
    case 0:
      return { x: -t, z: d, nx: 0, nz: 1 };
    case 1:
      return corner(-straightX, straightZ, Math.PI / 2);
    case 2:
      return { x: -w, z: straightZ - t, nx: -1, nz: 0 };
    case 3:
      return corner(-straightX, -straightZ, Math.PI);
    case 4:
      return { x: -straightX + t, z: -d, nx: 0, nz: -1 };
    case 5:
      return corner(straightX, -straightZ, (3 * Math.PI) / 2);
    case 6:
      return { x: w, z: -straightZ + t, nx: 1, nz: 0 };
    case 7:
      return corner(straightX, straightZ, 0);
    default:
      return { x: straightX - t, z: d, nx: 0, nz: 1 };
  }
}

/**
 * The order the house dealer deals in: clockwise from the button — the
 * seat after it (the small blind) first, the button last. The button comes
 * from the game state; the house dealer's own spot never changes the order.
 */
export function dealOrder(seats: readonly number[], buttonSeat: number): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const start = sorted.findIndex((s) => s > buttonSeat);
  return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
}

/** Seat fractions for any number of visible seats (2–9; anything else is spread evenly). */
export function seatFractions(count: number): readonly number[] {
  const preset = SEAT_FRACTIONS[count];
  if (preset) return preset;
  return Array.from({ length: count }, (_, i) => 0.08 + (0.84 * i) / Math.max(1, count - 1));
}

export interface SeatPlacement3d {
  seatId: number;
  /** Fraction around the edge (see edgePoint). */
  s: number;
  chair: EdgePoint;
  cards: EdgePoint;
  bet: EdgePoint;
  /** The dealer-button spot, offset to the player's right. */
  button: { x: number; z: number };
  /** Yaw (radians, about Y) that faces the table's center from the chair. */
  facing: number;
}

/**
 * Every visible seat's 3D spots. `seatIds` is the visible seats (an owner-
 * deleted seat is hidden, never renumbered — see ProjectedTableState.
 * removedSeatIds), assigned to the edge in ascending seat order.
 */
export function seatPlacements(seatIds: readonly number[]): SeatPlacement3d[] {
  const ordered = [...seatIds].sort((a, b) => a - b);
  const fractions = seatFractions(ordered.length);
  const railIn = TABLE.railWidth;
  return ordered.map((seatId, i) => {
    const s = fractions[i]!;
    const chair = edgePoint(s, -SEAT_SPOTS.chairOut);
    const cards = edgePoint(s, railIn + SEAT_SPOTS.cardsIn);
    const bet = edgePoint(s, railIn + SEAT_SPOTS.betIn);
    const btn = edgePoint(s, railIn + SEAT_SPOTS.buttonIn);
    // Facing the center (along -normal), the player's right-hand side is (nz, -nx).
    const button = { x: btn.x + btn.nz * SEAT_SPOTS.buttonSide, z: btn.z - btn.nx * SEAT_SPOTS.buttonSide };
    // A yaw that turns an object's local +Z toward the table's center.
    const facing = Math.atan2(-chair.nx, -chair.nz);
    return { seatId, s, chair, cards, bet, button, facing };
  });
}
