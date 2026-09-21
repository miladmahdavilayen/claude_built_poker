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
}

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
  rakePot: number;
  /**
   * Everyone waiting for a seat, in queue order. Visible to all viewers
   * (like `seats[].playerId`, waitlisted users aren't anonymous) so a
   * client can find its own entry by matching its own user id.
   */
  waitlist: readonly WaitlistEntry[];
}
