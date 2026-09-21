import type { TableState } from '@pokerclause/engine';
import type { SeatView } from './types.js';

/**
 * Projects a full TableState down to what one seat is allowed to see:
 * no `deck`, no `burned`, and every OTHER seat's `holeCards` redacted to
 * `[]` — even ones already publicly revealed at showdown, since a bot
 * never needs more than its own cards to decide its own action.
 */
export function projectSeatView(state: TableState, seatId: number): SeatView {
  return {
    seatId,
    handNumber: state.handNumber,
    config: state.config,
    buttonSeat: state.buttonSeat,
    street: state.street,
    board: state.board,
    betting: state.betting,
    pots: state.pots,
    phase: state.phase,
    seats: state.seats.map((s) => ({
      seatId: s.seatId,
      playerId: s.playerId,
      stack: s.stack,
      holeCards: s.seatId === seatId ? s.holeCards : [],
      status: s.status,
      committedThisStreet: s.committedThisStreet,
      committedThisHand: s.committedThisHand,
      hasActedThisRound: s.hasActedThisRound,
      isAllowedToRaise: s.isAllowedToRaise,
    })),
  };
}
