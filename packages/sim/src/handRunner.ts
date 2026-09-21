import { applyAction, getLegalActions, startHand, type Card, type GameEvent, type PlayerAction, type TableState } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { CoverageCounters } from './coverage.js';
import { HandFailure } from './handFailure.js';
import {
  checkActionBound,
  checkPayoutsEqualContributions,
  checkPotAwardOrder,
  checkPotCountBound,
  checkRaiseSizingTransition,
  checkStateInvariants,
  currentTotal,
  InvariantFailure,
  type InvariantViolation,
} from './invariants.js';
import { projectSeatView } from './projection.js';
import type { BotPolicy } from './types.js';

export interface HandRunResult {
  initialState: TableState;
  deck: readonly Card[];
  finalState: TableState;
  actionLog: PlayerAction[];
  events: GameEvent[];
}

export interface RunHandOptions {
  bots: ReadonlyMap<number, BotPolicy>;
  rnd: RandomSource;
  coverage: CoverageCounters;
  /** 0..100: chance, when a seat canRaise, to also probe minRaiseTo-1 and assert it's rejected. */
  adversarialProbeChance: number;
  maxActions?: number;
}

function safeApplyAction(state: TableState, action: PlayerAction) {
  try {
    return applyAction(state, action);
  } catch (err) {
    throw new InvariantFailure({
      code: 'ENGINE_THREW',
      message: `applyAction threw instead of returning { ok: false }: ${err instanceof Error ? err.message : String(err)}`,
      actual: action,
    });
  }
}

function safeStartHand(state: TableState, deck: readonly Card[]) {
  try {
    return startHand(state, deck);
  } catch (err) {
    throw new InvariantFailure({
      code: 'ENGINE_THREW',
      message: `startHand threw instead of returning { ok: false }: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function potAwardIndexesForThisHand(events: readonly GameEvent[]): number[] {
  return events.filter((e) => e.type === 'pot-awarded').map((e) => e.potIndex);
}

export function runOneHand(initialState: TableState, deck: readonly Card[], opts: RunHandOptions): HandRunResult {
  const initialTotal = currentTotal(initialState);
  const actionLog: PlayerAction[] = [];
  let stateBeforeCurrentStep = initialState;
  let currentAction: PlayerAction | null = null;

  const raise = (violation: InvariantViolation): never => {
    throw new HandFailure({
      violation,
      initialState,
      deck,
      actionLog,
      stateBeforeFailingAction: stateBeforeCurrentStep,
      failingAction: currentAction,
    });
  };

  try {
    const started = safeStartHand(initialState, deck);
    if (!started.ok) {
      throw new Error(`startHand rejected a hand the harness believed was startable: ${started.error.code}: ${started.error.message}`);
    }
    checkStateInvariants(started.state, initialTotal);

    let state = started.state;
    const events: GameEvent[] = [...started.events];
    let actionCount = 0;
    const maxActions = opts.maxActions ?? 500;

    while (state.phase === 'in-hand') {
      actionCount += 1;
      checkActionBound(actionCount, maxActions);

      const seatId = state.betting.actingSeat;
      if (seatId === null) throw new InvariantFailure({ code: 'NO_ACTING_SEAT', message: 'phase is in-hand but actingSeat is null' });
      const bot = opts.bots.get(seatId);
      if (!bot) throw new Error(`unreachable: no bot assigned to seat ${String(seatId)}`);

      const view = projectSeatView(state, seatId);
      const legal = getLegalActions(state, seatId);

      if (
        opts.adversarialProbeChance > 0 &&
        legal.canRaise &&
        legal.minRaiseTo - 1 > state.betting.currentBet &&
        opts.rnd.nextInt(100) < opts.adversarialProbeChance
      ) {
        const probeAmount = legal.minRaiseTo - 1;
        const probeAction: PlayerAction = { seatId, type: 'raise', amountTo: probeAmount };
        stateBeforeCurrentStep = state;
        currentAction = probeAction;
        const probe = safeApplyAction(state, probeAction);
        if (probe.ok) {
          throw new InvariantFailure({
            code: 'ILLEGAL_RAISE_ACCEPTED',
            message: `raise to minRaiseTo-1 (${String(probeAmount)}) was accepted but should have been rejected`,
          });
        }
        if (probe.error.code !== 'ILLEGAL_AMOUNT') {
          throw new InvariantFailure({
            code: 'WRONG_ERROR_CODE_FOR_ILLEGAL_RAISE',
            message: `expected ILLEGAL_AMOUNT for an under-sized raise, got ${probe.error.code}`,
          });
        }
        opts.coverage.bump('rejectedIllegalRaiseAtMinMinusOne');
      }

      let action = bot.decide(view, legal, opts.rnd);
      // Captured BEFORE calling applyAction: if the engine throws instead
      // of returning { ok: false }, this is exactly the {state, action}
      // pair that triggered it — critical for the repro file to actually
      // reproduce the failure, not the previous (successful) step's pair.
      stateBeforeCurrentStep = state;
      currentAction = action;
      let result = safeApplyAction(state, action);
      if (!result.ok) {
        action = legal.canCheck ? { seatId, type: 'check' } : { seatId, type: 'fold' };
        currentAction = action;
        result = safeApplyAction(state, action);
        if (!result.ok) {
          throw new InvariantFailure({
            code: 'FALLBACK_ACTION_REJECTED',
            message: `even the check/fold fallback was rejected: ${result.error.code}`,
          });
        }
      }

      const prevState = state;
      state = result.state;
      events.push(...result.events);
      actionLog.push(action);

      checkStateInvariants(state, initialTotal);
      checkRaiseSizingTransition(prevState, state, action);

      if (prevState.phase !== 'hand-complete' && state.phase === 'hand-complete') {
        checkPayoutsEqualContributions(state);
        checkPotCountBound(state);
        checkPotAwardOrder(potAwardIndexesForThisHand(result.events));
      }
    }

    return { initialState, deck, finalState: state, actionLog, events };
  } catch (err) {
    if (err instanceof HandFailure) throw err;
    if (err instanceof InvariantFailure) raise(err.violation);
    throw err;
  }
}
