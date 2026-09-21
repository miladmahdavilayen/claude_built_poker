export type Suit = 's' | 'h' | 'd' | 'c';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Rank}${Suit}`;

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'post-blind' | 'post-ante';

export type SeatStatus = 'active' | 'folded' | 'all-in' | 'sitting-out' | 'empty';

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  /** BB ante; 0 = off. */
  ante: number;
  /** 2..9 */
  maxSeats: number;
  straddleEnabled: boolean;
}

export interface SeatState {
  seatId: number;
  playerId: string;
  /** Chips behind, never negative. */
  stack: number;
  /** [] before deal. */
  holeCards: readonly Card[];
  status: SeatStatus;
  committedThisStreet: number;
  committedThisHand: number;
  hasActedThisRound: boolean;
  /** Reset when a full raise reopens action for this seat. */
  isAllowedToRaise: boolean;
  missedSmallBlind: boolean;
  missedBigBlind: boolean;
  /**
   * Engine bookkeeping: betting.currentBet at the moment this seat last
   * completed an action this street. Reset to 0 at the start of each
   * street. Used to detect cumulative short-all-in reopening — see
   * DECISIONS.md.
   */
  lastActedAtBet: number;
}

export interface Pot {
  /** 0 = main pot. */
  index: number;
  amount: number;
  /** Per-player contribution ceiling for this pot. */
  cappedAt: number;
  eligibleSeatIds: readonly number[];
}

export interface BettingState {
  /** Highest total any player has committed this street (includes short all-ins). */
  currentBet: number;
  /**
   * Size of the largest FULL bet/raise increment this street.
   * Determines the minimum legal raise, together with lastFullBetAmount.
   */
  lastFullRaiseIncrement: number;
  /**
   * The currentBet value established by the last FULL bet/raise (i.e.
   * excluding any short all-in raises since). The minimum legal raise is
   * anchored to this, not to `currentBet`, per the spec's worked example
   * (blinds 1/2, bet 10, raise to 25, short all-in to 30 => next min
   * raise is to 40 = 25 + 15, not 30 + 15). See DECISIONS.md.
   */
  lastFullBetAmount: number;
  /** Seat that made the last aggressive action (bet/raise, full or short), or null. */
  lastAggressorSeat: number | null;
  actingSeat: number | null;
}

export interface TableState {
  handNumber: number;
  config: TableConfig;
  seats: readonly SeatState[];
  buttonSeat: number;
  street: Street;
  board: readonly Card[];
  burned: readonly Card[];
  /** Remaining undealt cards, top of deck at index 0. */
  deck: readonly Card[];
  betting: BettingState;
  pots: readonly Pot[];
  phase: 'waiting' | 'in-hand' | 'hand-complete';
  actionSeq: number;
  /**
   * Engine bookkeeping for the moving-button algorithm: the seatId that
   * was big blind last hand, or null before the first hand. Not part of
   * the spec's literal shape but required to implement "BB always
   * advances exactly one live seat, never skips, never repeats" without
   * re-deriving history. See DECISIONS.md.
   */
  lastBigBlindSeat: number | null;
  /** Seat that posted a straddle this hand, or null. */
  straddleSeat: number | null;
  /**
   * Engine bookkeeping: true once hole cards have been revealed early
   * because no further betting is possible this hand (all-in runout).
   * Prevents a duplicate reveal at the final showdown. See DECISIONS.md.
   */
  allInRevealed: boolean;
  /**
   * Engine bookkeeping: total ante chips collected this hand, tracked
   * separately from any seat's committedThisHand. Antes are not part of
   * the calling/raising structure (only one seat pays the whole table's
   * ante in "BB ante" mode) and must not distort pot-layering's level or
   * eligibility comparisons; buildPots folds this into the main pot
   * amount directly instead. See DECISIONS.md.
   */
  anteTotal: number;
}

export interface PlayerAction {
  seatId: number;
  type: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /**
   * For bet/raise: the TOTAL amount to have committed this street
   * (i.e. "raise TO", not "raise BY"). Ignored for fold/check/call.
   */
  amountTo?: number;
}

export interface LegalActions {
  seatId: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canBet: boolean;
  minBet: number;
  maxBet: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  /** True when the only legal aggressive action is an under-sized all-in. */
  isAllInOnly: boolean;
}

export type EngineErrorCode =
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_AMOUNT'
  | 'RAISE_NOT_ALLOWED'
  | 'HAND_NOT_ACTIVE'
  | 'INVALID_ACTION_TYPE'
  | 'SEAT_NOT_ACTIVE'
  | 'UNKNOWN_SEAT'
  | 'HAND_ALREADY_IN_PROGRESS'
  | 'NOT_ENOUGH_PLAYERS'
  | 'INVALID_DECK'
  | 'CANNOT_CHECK'
  | 'CANNOT_CALL'
  | 'CANNOT_BET'
  | 'CANNOT_FOLD';

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

export type BlindPostKind =
  | 'small-blind'
  | 'big-blind'
  | 'straddle'
  | 'missed-big-blind';

export interface BlindPost {
  seatId: number;
  kind: BlindPostKind;
  amount: number;
  /** True when this seat did not have enough chips to cover the full amount. */
  allIn: boolean;
}

export interface ShowdownWinner {
  seatId: number;
  amount: number;
  /** Omitted when the pot was won uncontested (no showdown occurred). */
  handName?: string;
  bestFive?: readonly Card[];
}

export type GameEvent =
  | { type: 'hand-started'; handNumber: number; buttonSeat: number; smallBlindSeat: number | null; bigBlindSeat: number }
  | { type: 'ante-posted'; posts: readonly { seatId: number; amount: number }[] }
  | { type: 'blinds-posted'; posts: readonly BlindPost[] }
  | { type: 'cards-dealt'; deals: readonly { seatId: number; cards: readonly Card[] }[] }
  | { type: 'action-taken'; seatId: number; action: PlayerAction; resultingStack: number; committedThisStreet: number }
  | { type: 'street-dealt'; street: Street; board: readonly Card[]; burned: Card }
  | { type: 'betting-round-closed'; street: Street }
  | { type: 'uncalled-bet-returned'; seatId: number; amount: number }
  | { type: 'pots-formed'; pots: readonly Pot[] }
  | { type: 'showdown-reveal'; seatId: number; holeCards: readonly Card[] }
  | { type: 'pot-awarded'; potIndex: number; winners: readonly ShowdownWinner[] }
  | { type: 'hand-complete'; handNumber: number };

export type EngineResult =
  | { ok: true; state: TableState; events: GameEvent[] }
  | { ok: false; error: EngineError };
