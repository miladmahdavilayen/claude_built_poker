import { needsToAct, syncAllowedToRaiseFlags } from './betting.js';
import { applyPlayerAction } from './betting.js';
import { createDefaultEvaluator, type HandEvaluator } from './evaluator.js';
import { prepareAndDealHand } from './hand.js';
import { computeLegalActions } from './legalActions.js';
import { awardFoldWin, runShowdown } from './showdown.js';
import { dealFlop, dealRiver, dealTurn } from './streets.js';
import type { Draft } from './table.js';
import { contendingSeatIds, fromDraft, nextPending, requireSeat, toDraft } from './table.js';
import type { Card, EngineResult, GameEvent, LegalActions, PlayerAction, TableState } from './types.js';

const defaultEvaluator: HandEvaluator = createDefaultEvaluator();

function advance(draft: Draft, evaluator: HandEvaluator): GameEvent[] {
  const events: GameEvent[] = [];

  for (;;) {
    const contenders = contendingSeatIds(draft.seats);
    if (contenders.length <= 1) {
      const winnerId = contenders[0];
      if (winnerId !== undefined) {
        events.push(...awardFoldWin(draft, winnerId));
      }
      draft.phase = 'hand-complete';
      draft.betting.actingSeat = null;
      events.push({ type: 'hand-complete', handNumber: draft.handNumber });
      return events;
    }

    // At most one contender has chips left behind: nobody could ever
    // respond to a further bet, so a seat only pending because it hasn't
    // formally "checked" yet (nothing owed) must not be prompted for that
    // pointless decision. A seat that still owes a call, though, gets a
    // real decision regardless — going all-in is meaningful even with
    // nobody left to raise against.
    const activeWithChips = draft.seats.filter((s) => s.status === 'active' && s.stack > 0).length;
    const pending = needsToAct(draft).filter((seatId) => {
      if (activeWithChips > 1) return true;
      const seat = requireSeat(draft.seats, seatId);
      return seat.committedThisStreet < draft.betting.currentBet;
    });
    if (pending.length > 0) {
      const anchor = draft.betting.actingSeat ?? draft.buttonSeat;
      draft.betting.actingSeat = nextPending(draft.seats, anchor, new Set(pending));
      syncAllowedToRaiseFlags(draft);
      return events;
    }

    events.push({ type: 'betting-round-closed', street: draft.street });

    if (draft.street === 'river') {
      events.push(...runShowdown(draft, evaluator));
      draft.phase = 'hand-complete';
      draft.betting.actingSeat = null;
      events.push({ type: 'hand-complete', handNumber: draft.handNumber });
      return events;
    }

    if (activeWithChips <= 1 && !draft.allInRevealed) {
      for (const seatId of contendingSeatIds(draft.seats)) {
        const seat = requireSeat(draft.seats, seatId);
        events.push({ type: 'showdown-reveal', seatId, holeCards: [...seat.holeCards] });
      }
      draft.allInRevealed = true;
    }

    if (draft.street === 'preflop') events.push(...dealFlop(draft));
    else if (draft.street === 'flop') events.push(...dealTurn(draft));
    else events.push(...dealRiver(draft));

    draft.betting.actingSeat = draft.buttonSeat;
  }
}

export function startHand(state: TableState, deck: readonly Card[]): EngineResult {
  const draft = toDraft(state);
  const prepared = prepareAndDealHand(draft, deck);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const events = [...prepared.events, ...advance(draft, defaultEvaluator)];
  return { ok: true, state: fromDraft(draft), events };
}

export function getLegalActions(state: TableState, seatId: number): LegalActions {
  // Pure read — no clone needed (see LegalActionsView's doc comment).
  return computeLegalActions(state, seatId);
}

export function applyAction(state: TableState, action: PlayerAction): EngineResult {
  const draft = toDraft(state);
  const result = applyPlayerAction(draft, action);
  if (!result.ok) return { ok: false, error: result.error };
  draft.actionSeq += 1;
  const events = [...result.events, ...advance(draft, defaultEvaluator)];
  return { ok: true, state: fromDraft(draft), events };
}
