import type { BettingState, Card, LegalActions, Pot, SeatStatus, Street, TableConfig } from '@pokerclause/engine';

export interface TableSettings extends TableConfig {
  minBuyIn: number;
  maxBuyIn: number;
  actionSeconds: number;
  timeBankSeconds: number;
  runItTwiceEnabled: boolean;
  rakePercent: number;
  rakeCap: number;
  noFlopNoDrop: boolean;
  isPrivate: boolean;
  disableChatInHand: boolean;
  /**
   * An open-invite table: anyone holding its link (`?code=` — see
   * apps/server's open-invite tables) can pick a free seat themselves, or
   * join the waitlist when it's full. Absent on every other table.
   */
  openSeating?: boolean;
  /**
   * An open-invite table's starting chips (cents): what each new player who
   * comes by its link sits down with. A player who leaves and comes back
   * sits with what they left with instead. Absent on every other table.
   */
  openSeatStack?: number;
  /**
   * Which character deals on the 3D table (an id from
   * apps/web/public/models/dealers/index.json); absent or '' for the
   * built-in dealer. Purely how the table looks — the owner picks it by
   * double-tapping the house dealer, and everyone at the table sees it.
   */
  houseDealer?: string;
}

/** On an open-invite table, a free seat held for the first person on the waitlist until `expiresAt` (epoch ms). */
export interface SeatOffer {
  userId: string;
  displayName: string;
  expiresAt: number;
}

export interface WaitlistEntry {
  userId: string;
  displayName: string;
}

export interface ProjectedSeat {
  seatId: number;
  playerId: string | null;
  displayName: string | null;
  isGuest: boolean;
  avatarSeed: string | null;
  stack: number;
  /** Real cards only for the viewer's own seat, or a seat revealed at showdown; [] otherwise. */
  holeCards: readonly Card[];
  status: SeatStatus;
  committedThisStreet: number;
  committedThisHand: number;
  hasActedThisRound: boolean;
  isAllowedToRaise: boolean;
  isConnected: boolean;
  missedSmallBlind: boolean;
  missedBigBlind: boolean;
  lastAction: { type: string; amountTo?: number } | null;
  timeBankMs: number;
  /** A computer player (see packages/sim's bot policies) — never a real user, never in the chip ledger. */
  isBot: boolean;
  /**
   * A private label the owner gave this seat's invite link when they
   * generated it (e.g. "Dave from work") — ALWAYS `null` in every
   * projection except the one sent to the owner's own admin room, same
   * anti-cheat boundary as hole cards. See `projection.ts`.
   */
  ownerNickname: string | null;
  /** Chips the owner already added (and debited) that land on this seat's stack the moment the current hand ends — 0 when nothing is pending. */
  pendingChips: number;
  /** The owner removed this player (or deleted this seat) mid-hand: they're auto-folded on their turn and leave, refunded, when this hand ends. */
  leavingAfterHand: boolean;
  /** Seated mid-hand — dealt in from the next hand. */
  joiningNextHand: boolean;
  /** This player asked to move to that empty seat mid-hand: they move the moment the hand ends. Null otherwise. */
  movingToSeatId: number | null;
}

/** Blind/ante/straddle changes the owner made mid-hand, applied from the next deal. */
export type PendingTableSettings = Partial<Pick<TableSettings, 'smallBlind' | 'bigBlind' | 'ante' | 'straddleEnabled'>>;

/**
 * What one viewer (a seated player or a spectator) is allowed to receive
 * over the wire for a table. NEVER contains `deck`, `burned`, or another
 * seat's `holeCards` outside of a genuine showdown reveal. See
 * `projection.ts`'s `projectStateForSeat` and its dedicated leak test.
 */
export interface ProjectedTableState {
  tableId: string;
  tableName: string;
  handId: string | null;
  handNumber: number;
  /** Echo this back in the next action's `actionSeq` — the server rejects a mismatch as stale/duplicate. */
  actionSeq: number;
  /**
   * SHA256(serverSeed) for the current hand, published as soon as the hand
   * starts — before any card is revealed to anyone. After the hand, look
   * up `GET /fairness/:handId` for the revealed serverSeed and re-derive
   * the deck yourself; it must hash to this same value. See FAIRNESS.md.
   */
  handCommitment: string | null;
  settings: TableSettings;
  seats: readonly ProjectedSeat[];
  buttonSeat: number;
  street: Street;
  board: readonly Card[];
  betting: BettingState;
  pots: readonly Pot[];
  /**
   * Antes collected so far this hand — not yet folded into `pots` (that
   * only happens once pots are actually built, at showdown/hand-end; see
   * packages/engine/src/pots.ts). Add this to the sum of every seat's
   * `committedThisHand` for the true "live" pot total mid-hand.
   */
  anteTotal: number;
  phase: 'waiting' | 'in-hand' | 'hand-complete';
  /**
   * True once enough players are dealt-in (2+, including at least one real
   * human) that a hand COULD start — but nothing deals automatically. A
   * seated player must explicitly trigger the `start-hand` socket event
   * (the "Play Hand" button) for every hand, including the first. See
   * DECISIONS.md.
   */
  canStartHand: boolean;
  /** Only ever populated when it's genuinely this viewer's own seat's turn. */
  legalActions: LegalActions | null;
  viewerSeatId: number | null;
  /** Epoch ms absolute deadline for the current acting seat's decision, or null. */
  actionDeadline: number | null;
  /** Epoch ms — a new hand can't start before this (the post-hand shuffle break), or null once it's over/not applicable. */
  nextHandAt: number | null;
  /**
   * The seat that won the just-finished hand entirely because every other
   * player folded (never had to show anything) and hasn't yet chosen to
   * voluntarily reveal — `null` the rest of the time, including once that
   * seat has revealed. A seat only ever sees its OWN reveal button by
   * comparing this to its own `viewerSeatId`; every viewer receives the
   * same value (the seat id itself isn't sensitive, unlike hole cards).
   */
  revealEligibleSeatId: number | null;
  rakePot: number;
  /**
   * Everyone waiting for a seat, in queue order. Visible to all viewers
   * (like `seats[].playerId`, waitlisted users aren't anonymous) so a
   * client can find its own entry by matching its own user id.
   */
  waitlist: readonly WaitlistEntry[];
  /**
   * Seat slots the owner deleted — not shown, not sittable. Seat ids stay
   * stable for the table's lifetime (every in-hand structure — button,
   * pots, acting seat — refers to them), so a deleted seat is hidden
   * rather than renumbered. Visible seats = `seats` minus these.
   */
  removedSeatIds: readonly number[];
  /** Blind/ante/straddle changes queued for the next hand, or null. `settings` always shows what's in force right now. */
  pendingSettings: PendingTableSettings | null;
  /** On an open-invite table: the free seat currently held for the waitlist's first person, or null. */
  seatOffer: SeatOffer | null;
}
