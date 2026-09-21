import type { SeatState, TableState } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { CoverageCounters } from './coverage.js';

export interface ChurnConfig {
  minBuyInBB: number;
  maxBuyInBB: number;
  /** 0..100 chance per event, checked once per relevant seat per hand. */
  bustRebuyChance: number;
  newPlayerChance: number;
  sitOutChance: number;
  sitInChance: number;
  leaveChance: number;
  blindRaiseChance: number;
}

export const DEFAULT_CHURN_CONFIG: ChurnConfig = {
  minBuyInBB: 40,
  maxBuyInBB: 100,
  bustRebuyChance: 60,
  newPlayerChance: 8,
  sitOutChance: 4,
  sitInChance: 35,
  leaveChance: 3,
  blindRaiseChance: 1,
};

function randomBuyIn(bigBlind: number, cfg: ChurnConfig, rnd: RandomSource): number {
  const min = cfg.minBuyInBB * bigBlind;
  const max = cfg.maxBuyInBB * bigBlind;
  return min + rnd.nextInt(max - min + 1);
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

function freshActiveSeat(seatId: number, playerId: string, stack: number): SeatState {
  return { ...emptySeat(seatId), playerId, stack, status: 'active' };
}

/**
 * Applies random table churn between hands: bust/rebuy, new players
 * taking empty seats, sit-out/sit-in, players leaving mid-orbit, and
 * occasional blind-level increases. Runs only when `state.phase !==
 * 'in-hand'`. Guarantees at least 2 active seats with chips survive so
 * the run never stalls.
 */
export function churnBetweenHands(state: TableState, rnd: RandomSource, cfg: ChurnConfig, coverage: CoverageCounters): TableState {
  const seats = state.seats.map((s) => ({ ...s }));
  let config = state.config;
  let nextPlayerId = 0;
  const freshId = (): string => `R${state.handNumber.toString()}-${(nextPlayerId++).toString()}`;

  // 1. Busted seats: rebuy or remove.
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i]!;
    if (s.status !== 'empty' && s.stack === 0) {
      if (rnd.nextInt(100) < cfg.bustRebuyChance) {
        seats[i] = freshActiveSeat(s.seatId, s.playerId || freshId(), randomBuyIn(config.bigBlind, cfg, rnd));
      } else {
        seats[i] = emptySeat(s.seatId);
      }
    }
  }

  // 2. New players taking empty seats.
  for (let i = 0; i < seats.length; i++) {
    if (seats[i]!.status === 'empty' && rnd.nextInt(100) < cfg.newPlayerChance) {
      seats[i] = freshActiveSeat(i, freshId(), randomBuyIn(config.bigBlind, cfg, rnd));
    }
  }

  // 3. Sit-out / sit-in (approximates the missed-blind decision at the
  // simulation layer, since M1's engine doesn't automate it — see
  // packages/sim/README.md).
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i]!;
    if (s.status === 'active' && rnd.nextInt(100) < cfg.sitOutChance) {
      seats[i] = { ...s, status: 'sitting-out' };
    } else if (s.status === 'sitting-out' && rnd.nextInt(100) < cfg.sitInChance) {
      if (rnd.nextInt(2) === 0) {
        coverage.bump('missedBlindPosted');
        seats[i] = { ...s, status: 'active' };
      } else {
        coverage.bump('waitedForBB');
      }
    }
  }

  // 4. Leaving mid-orbit (independent of busting — forces dead-button situations).
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i]!;
    if ((s.status === 'active' || s.status === 'sitting-out') && rnd.nextInt(100) < cfg.leaveChance) {
      seats[i] = emptySeat(s.seatId);
    }
  }

  // 5. Occasional blind increase.
  // Capped well below Number.MAX_SAFE_INTEGER: over a long table lifetime,
  // repeated doublings (even at a 1% chance/hand) combined with stacks
  // that also grow from winnings can otherwise compound into values where
  // JS floating-point arithmetic silently loses precision — which then
  // trips the chip-conservation invariant on a false positive that has
  // nothing to do with the engine. Real cash games don't escalate blinds
  // without bound either.
  const MAX_BIG_BLIND = 1_000_000;
  if (rnd.nextInt(100) < cfg.blindRaiseChance && config.bigBlind * 2 <= MAX_BIG_BLIND) {
    config = { ...config, smallBlind: config.smallBlind * 2, bigBlind: config.bigBlind * 2 };
  }

  // Never let the run stall: guarantee at least 2 active seats with chips.
  let activeWithChips = seats.filter((s) => s.status === 'active' && s.stack > 0).length;
  for (let i = 0; i < seats.length && activeWithChips < 2; i++) {
    if (seats[i]!.status !== 'active' || seats[i]!.stack === 0) {
      seats[i] = freshActiveSeat(i, freshId(), randomBuyIn(config.bigBlind, cfg, rnd));
      activeWithChips += 1;
    }
  }

  return { ...state, seats, config, phase: 'waiting' };
}
