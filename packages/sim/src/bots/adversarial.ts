import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';

/**
 * Deliberately biased toward the states that break poker engines: raises
 * pinned to the exact legal boundaries (min/max), and all-ins whenever
 * raising is legal at all (which is what produces short all-ins that
 * don't reopen action, cumulative-reopening chains, and 3+ distinct
 * all-in levels in one hand once several of these are seated together
 * with varied stack sizes from table churn).
 *
 * Deliberately-illegal probes (minRaiseTo - 1, expected to be rejected)
 * are the harness's job, not this policy's — see harness.ts's
 * `probeIllegalRaise`. A BotPolicy always returns what it actually wants
 * to do; the harness decides whether/when to also fire an out-of-band
 * illegal-amount probe alongside it.
 *
 * One deliberate cap: a bare minimum re-raise is only preferred while
 * currentBet is still within ~50 big blinds. With deep stacks
 * accumulated over a long churned table lifetime, two of these bots
 * volleying pure min-raises at each other is legal every step but can
 * volley for hundreds of actions — a bot-behavior pathology, not
 * something the reopening/sizing rules need to bound, so it's fixed
 * here rather than by loosening the engine's own action-count invariant
 * (found via the M2 harness at ~1M hands; see the project report).
 */
export const adversarial: BotPolicy = {
  name: 'adversarial',
  decide(view: SeatView, legal: LegalActions, rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    const roll = rnd.nextInt(100);
    const raisingWarIsDeep = view.betting.currentBet > view.config.bigBlind * 50;

    if (legal.canRaise) {
      if (roll < 40) return { seatId, type: 'raise', amountTo: legal.maxRaiseTo }; // shove: often a short all-in
      if (roll < 70 && !raisingWarIsDeep) return { seatId, type: 'raise', amountTo: legal.minRaiseTo }; // exact minimum
      if (roll < 70) return { seatId, type: 'raise', amountTo: legal.maxRaiseTo }; // de-escalate: shove instead of volleying forever
      if (legal.canCall) return { seatId, type: 'call' };
    }
    if (legal.canBet) {
      if (roll < 50) return { seatId, type: 'bet', amountTo: legal.maxBet };
      return { seatId, type: 'bet', amountTo: legal.minBet };
    }
    if (legal.canCall) return { seatId, type: 'call' };
    if (legal.canCheck) return { seatId, type: 'check' };
    return { seatId, type: 'fold' };
  },
};
