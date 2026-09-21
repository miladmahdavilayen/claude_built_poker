import type { PlayerAction } from '@pokerclause/engine';
import type { CoverageCounters } from './coverage.js';
import type { HandRunResult } from './handRunner.js';

/**
 * Inspects one completed hand's event log and final state, bumping every
 * spec-required coverage counter it recognizes. `deadButtonSuspected` is
 * supplied by the harness's churn layer: true when a seat was removed
 * since the last hand, which is when a dead-button situation (see engine
 * DECISIONS.md #3 — the compacted-ring model, not literal seat-parking)
 * can occur.
 */
export function observeCoverage(hand: HandRunResult, coverage: CoverageCounters, deadButtonSuspected: boolean): void {
  const { finalState, events, actionLog } = hand;

  const handStarted = events.find((e) => e.type === 'hand-started');
  const dealt = events.find((e) => e.type === 'cards-dealt');
  const dealtCount = dealt && dealt.type === 'cards-dealt' ? dealt.deals.length : 0;
  if (dealtCount === 2) coverage.bump('headsUpHand');

  if (finalState.pots.length === 2) coverage.bump('potsExactly2');
  else if (finalState.pots.length === 3) coverage.bump('potsExactly3');
  else if (finalState.pots.length >= 4) coverage.bump('pots4OrMore');

  if (events.some((e) => e.type === 'uncalled-bet-returned')) coverage.bump('uncalledBetReturned');

  if (finalState.seats.some((s) => s.status === 'folded' && s.committedThisHand > 0)) {
    coverage.bump('foldedContributorChipsStayed');
  }

  if (finalState.config.ante > 0) coverage.bump('anteHand');
  if (finalState.straddleSeat !== null || events.some((e) => e.type === 'blinds-posted' && e.posts.some((p) => p.kind === 'straddle'))) {
    coverage.bump('straddledHand');
  }

  if (deadButtonSuspected) coverage.bump('deadButtonHand');

  const potAwards = events.filter((e) => e.type === 'pot-awarded');
  if (potAwards.length > 0) {
    for (const e of potAwards) {
      if (e.type !== 'pot-awarded') continue;
      if (e.winners.length === 3) coverage.bump('threeWaySplit');
      if (e.winners.length >= 2) {
        const amounts = new Set(e.winners.map((w) => w.amount));
        if (amounts.size > 1) coverage.bump('splitPotOddChip');
      }
    }
    const first = potAwards[0];
    const last = potAwards[potAwards.length - 1];
    if (first && last && first.type === 'pot-awarded' && last.type === 'pot-awarded' && first.potIndex !== last.potIndex) {
      const mainWinners = new Set(first.winners.map((w) => w.seatId));
      const sideWinners = new Set(last.winners.map((w) => w.seatId));
      const overlaps = [...mainWinners].some((s) => sideWinners.has(s));
      if (!overlaps) coverage.bump('sidePotDifferentWinnerThanMain');
    }
  }

  const hasReveal = events.some((e) => e.type === 'showdown-reveal');
  const firstRevealIdx = events.findIndex((e) => e.type === 'showdown-reveal');
  const firstStreetDealtIdx = events.findIndex((e) => e.type === 'street-dealt');
  if (hasReveal && (firstStreetDealtIdx === -1 || firstRevealIdx < firstStreetDealtIdx)) {
    coverage.bump('allInPreflopRanOutAllStreets');
  }

  if (!hasReveal && handStarted && handStarted.type === 'hand-started' && potAwards.length === 1) {
    const winner = potAwards[0];
    if (winner && winner.type === 'pot-awarded' && winner.winners.length === 1 && winner.winners[0]!.seatId === handStarted.bigBlindSeat) {
      coverage.bump('everyoneFoldsToBB');
    }
  }

  if (handStarted && handStarted.type === 'hand-started') {
    const bbSeat = handStarted.bigBlindSeat;
    const bbActionIdx = actionLog.findIndex((a) => a.seatId === bbSeat);
    if (bbActionIdx > 0) {
      const priorAllCalls = actionLog.slice(0, bbActionIdx).every((a) => a.type === 'call');
      if (priorAllCalls && actionLog[bbActionIdx]!.type === 'raise') {
        coverage.bump('bbOptionRaiseOnLimpedPot');
      }
    }
  }

  if (events.some((e) => e.type === 'blinds-posted' && e.posts.some((p) => p.allIn && p.amount < finalState.config.smallBlind))) {
    coverage.bump('allInLessThanSmallBlind');
  }

  observeReopeningPatterns(hand, coverage);
}

/**
 * Walks the hand's event stream (not just actionLog, so street boundaries
 * are known) re-deriving full/short raise classification to spot the two
 * reopening coverage cases.
 */
function observeReopeningPatterns(hand: HandRunResult, coverage: CoverageCounters): void {
  let currentBet = 0;
  let lastFullRaiseIncrement = hand.finalState.config.bigBlind;
  const lastActedAtBet = new Map<number, number>();
  let lastRaiseWasFull = true;
  let sawAnyRaise = false;

  for (const event of hand.events) {
    if (event.type === 'street-dealt') {
      currentBet = 0;
      lastFullRaiseIncrement = hand.finalState.config.bigBlind;
      lastActedAtBet.clear();
      lastRaiseWasFull = true;
      sawAnyRaise = false;
      continue;
    }
    if (event.type === 'blinds-posted') {
      currentBet = Math.max(0, ...event.posts.map((p) => p.amount));
      continue;
    }
    if (event.type !== 'action-taken') continue;

    const action: PlayerAction = event.action;
    if (action.type === 'bet' || action.type === 'raise') {
      const priorBet = currentBet;
      const priorIncrement = lastFullRaiseIncrement;
      const amountTo = action.amountTo ?? priorBet;
      const increment = amountTo - priorBet;
      const isFull = increment >= priorIncrement;

      if (sawAnyRaise && !isFull) {
        // Check every OTHER seat that already acted this street: are they
        // reopened by this raise (possibly cumulatively, combined with
        // earlier short raises since they last acted), or not?
        let anyNotReopened = false;
        let anyCumulativelyReopened = false;
        for (const [seatId, actedAtBet] of lastActedAtBet) {
          if (seatId === event.seatId) continue;
          const growth = amountTo - actedAtBet;
          if (growth < priorIncrement) anyNotReopened = true;
          else if (!lastRaiseWasFull) anyCumulativelyReopened = true;
        }
        if (anyNotReopened) coverage.bump('shortAllInDidNotReopen');
        if (anyCumulativelyReopened) coverage.bump('cumulativeShortAllInReopened');
      }

      currentBet = amountTo;
      if (isFull) lastFullRaiseIncrement = increment;
      lastRaiseWasFull = isFull;
      sawAnyRaise = true;
      lastActedAtBet.set(event.seatId, currentBet);
    } else if (action.type === 'call' || action.type === 'check') {
      lastActedAtBet.set(event.seatId, currentBet);
    }
  }
}
