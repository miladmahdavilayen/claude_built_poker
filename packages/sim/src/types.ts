import type { BettingState, Card, LegalActions, PlayerAction, Pot, SeatStatus, Street, TableConfig, TableState } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';

/** A single seat as visible from another seat's point of view: no other seat's hole cards, ever. */
export interface SeatViewSeat {
  seatId: number;
  playerId: string;
  stack: number;
  /** Real cards only for the viewing seat; [] for every other seat, always — even after a real showdown reveal. */
  holeCards: readonly Card[];
  status: SeatStatus;
  committedThisStreet: number;
  committedThisHand: number;
  hasActedThisRound: boolean;
  isAllowedToRaise: boolean;
}

/**
 * What a bot (or a projected client) is allowed to see: no undealt deck,
 * no burned cards, no other seat's hole cards. This is the enforcement
 * boundary the spec asks for — bots only ever receive a SeatView, never a
 * TableState.
 */
export interface SeatView {
  seatId: number;
  handNumber: number;
  config: TableConfig;
  seats: readonly SeatViewSeat[];
  buttonSeat: number;
  street: Street;
  board: readonly Card[];
  betting: BettingState;
  pots: readonly Pot[];
  phase: TableState['phase'];
}

export interface BotPolicy {
  name: string;
  decide(view: SeatView, legal: LegalActions, rnd: RandomSource): PlayerAction;
}
