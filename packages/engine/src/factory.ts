import type { SeatState, TableConfig, TableState } from './types.js';

export interface SeatSetup {
  seatId: number;
  playerId: string;
  stack: number;
}

function emptySeat(seatId: number): SeatState {
  return {
    seatId,
    playerId: '',
    stack: 0,
    holeCards: [],
    status: 'empty',
    committedThisStreet: 0,
    committedThisHand: 0,
    hasActedThisRound: false,
    isAllowedToRaise: true,
    missedSmallBlind: false,
    missedBigBlind: false,
    lastActedAtBet: 0,
  };
}

/** Builds a fresh, unstarted TableState. No randomness; not part of a running hand. */
export function createTableState(config: TableConfig, players: readonly SeatSetup[]): TableState {
  const seats: SeatState[] = [];
  for (let seatId = 0; seatId < config.maxSeats; seatId++) {
    const player = players.find((p) => p.seatId === seatId);
    if (player) {
      seats.push({ ...emptySeat(seatId), playerId: player.playerId, stack: player.stack, status: 'active' });
    } else {
      seats.push(emptySeat(seatId));
    }
  }

  return {
    handNumber: 0,
    config,
    seats,
    buttonSeat: 0,
    street: 'preflop',
    board: [],
    burned: [],
    deck: [],
    betting: { currentBet: 0, lastFullRaiseIncrement: config.bigBlind, lastFullBetAmount: 0, lastAggressorSeat: null, actingSeat: null },
    pots: [],
    phase: 'waiting',
    actionSeq: 0,
    lastBigBlindSeat: null,
    straddleSeat: null,
    allInRevealed: false,
    anteTotal: 0,
  };
}
