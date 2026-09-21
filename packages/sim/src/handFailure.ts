import type { Card, PlayerAction, TableState } from '@pokerclause/engine';
import type { InvariantViolation } from './invariants.js';

/**
 * Everything needed to reproduce and shrink a failure: the full hand
 * context, plus — crucially — the state immediately before the failing
 * transition and the single action that triggered it. Since TableState is
 * a complete, self-sufficient snapshot, {stateBeforeFailingAction,
 * failingAction} is already a minimal, one-action repro on its own; no
 * search-based shrinking is needed to get there.
 */
export class HandFailure extends Error {
  readonly violation: InvariantViolation;
  readonly initialState: TableState;
  readonly deck: readonly Card[];
  readonly actionLog: readonly PlayerAction[];
  readonly stateBeforeFailingAction: TableState;
  readonly failingAction: PlayerAction | null;

  constructor(params: {
    violation: InvariantViolation;
    initialState: TableState;
    deck: readonly Card[];
    actionLog: readonly PlayerAction[];
    stateBeforeFailingAction: TableState;
    failingAction: PlayerAction | null;
  }) {
    super(`[${params.violation.code}] ${params.violation.message}`);
    this.violation = params.violation;
    this.initialState = params.initialState;
    this.deck = params.deck;
    this.actionLog = params.actionLog;
    this.stateBeforeFailingAction = params.stateBeforeFailingAction;
    this.failingAction = params.failingAction;
  }
}
