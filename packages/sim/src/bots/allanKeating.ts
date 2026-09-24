import type { LegalActions, PlayerAction } from '@pokerclause/engine';
import type { RandomSource } from '@pokerclause/rng';
import type { BotPolicy, SeatView } from '../types.js';
import { estimateEquity } from './equity.js';
import { ownSeat } from './helpers.js';

// Preflop needs to fill the WHOLE board (5 unknown cards, plus 2 per
// opponent) on every single sample, so it gets fewer of them than a
// postflop street (where most or all of the board is already fixed) to
// keep one decision fast — see equity.ts. Kept deliberately modest (not
// the few thousand samples a standalone equity calculator would use) for
// a real reason beyond live-table responsiveness: this bot is a `BotPolicy`
// like any other, so it's swept automatically into every large-scale
// simulation via `ALL_BOT_POLICIES` — the CI deploy gate's 20k-hand smoke
// test, the nightly 1,000,000-hand run, and packages/sim's own
// perf/harness/golden test suites (run on every commit via the repo's
// pre-commit/pre-push hooks) all include it with no opt-out. See also
// MAX_SIMULATED_OPPONENTS below, the other half of keeping this bounded.
// The threshold margins in `decide()` (0.18 raise edge, -0.03 call
// tolerance) are deliberately wide enough to stay correct despite the
// resulting Monte Carlo noise (~±8-12% at these sample sizes).
const PREFLOP_SAMPLES = 25;
const POSTFLOP_SAMPLES = 40;

// Simulating every live opponent at a full 9-max table (up to 8) makes
// each sample scale with table size for no real decision-quality benefit
// past a few opponents — the qualitative "am I ahead of this many random
// hands" answer stops moving much beyond this, while the cost keeps
// climbing linearly. Capping it bounds the worst case (a full ring) to
// roughly the same per-decision cost as a 5-handed table.
const MAX_SIMULATED_OPPONENTS = 4;

// How much extra "equity credit" late position buys — deliberately small:
// position sharpens a numbers-driven decision (more information, more
// fold equity, better implied odds), it never overrides what the equity
// estimate itself says.
const MAX_POSITION_EDGE = 0.04;

// Below this stack-to-pot ratio, a smaller bet/raise just invites being
// shoved on with worse odds to continue than committing outright would
// have given — standard short-stack theory (this is what a well-sized bet
// means once the money's mostly already effectively committed, not a
// special case carved out for this one bot).
const SHOVE_SPR = 2.5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sizeToward(min: number, max: number, fraction: number): number {
  if (max <= min) return min;
  return Math.round(min + (max - min) * clamp(fraction, 0, 1));
}

function liveOpponentCount(view: SeatView): number {
  return view.seats.filter((s) => s.seatId !== view.seatId && (s.status === 'active' || s.status === 'all-in')).length;
}

/** Chips already in the middle this hand, across every street. Antes are a small, deliberately rough addition — a SeatView doesn't break them out per seat, only the table-wide config amount. */
function potSize(view: SeatView): number {
  const committed = view.seats.reduce((sum, s) => sum + s.committedThisHand, 0);
  return committed + view.config.ante;
}

/** 0 (acts first postflop, worst) .. 1 (the button, best) — coarse, but directionally correct regardless of how many seats are folded/empty. */
function positionScore(view: SeatView): number {
  const maxSeats = view.config.maxSeats;
  if (maxSeats <= 1) return 1;
  const distance = (((view.seatId - (view.buttonSeat + 1)) % maxSeats) + maxSeats) % maxSeats;
  return distance / (maxSeats - 1);
}

/**
 * Allan Keating: a purely numbers-driven NLHE cash-game bot. Every
 * decision comes from a Monte Carlo equity estimate (equity.ts) against
 * however many opponents are actually still live in the hand, weighed
 * against the real pot odds on offer, with small, well-justified
 * adjustments for position and stack-to-pot ratio — never a hunch, a
 * fixed starting-hand chart, or a randomized bluff frequency. It folds
 * hands with a negative expectation and sizes bets/raises to how far
 * ahead the numbers say it is, the way a disciplined, tight-aggressive
 * winning cash player would explain their own decisions.
 */
export const allanKeating: BotPolicy = {
  name: 'allan-keating',
  decide(view: SeatView, legal: LegalActions, rnd: RandomSource): PlayerAction {
    const seatId = view.seatId;
    const seat = ownSeat(view);
    const opponents = liveOpponentCount(view);
    if (opponents <= 0) {
      if (legal.canCheck) return { seatId, type: 'check' };
      if (legal.canCall) return { seatId, type: 'call' };
      return { seatId, type: 'fold' };
    }

    const samples = view.street === 'preflop' ? PREFLOP_SAMPLES : POSTFLOP_SAMPLES;
    const equity = estimateEquity(seat.holeCards, view.board, Math.min(opponents, MAX_SIMULATED_OPPONENTS), rnd, samples);
    const pot = potSize(view);
    const position = positionScore(view);
    const positionEdge = position * MAX_POSITION_EDGE;
    const spr = seat.stack / Math.max(1, pot);

    if (legal.canCall) {
      const toCall = legal.callAmount;
      const neededEquity = toCall / (pot + toCall);
      const edge = equity + positionEdge - neededEquity;

      if (legal.canRaise && edge >= 0.18) {
        const amountTo =
          spr <= SHOVE_SPR || equity >= 0.85 ? legal.maxRaiseTo : sizeToward(legal.minRaiseTo, legal.maxRaiseTo, edge * 2);
        return { seatId, type: 'raise', amountTo };
      }
      if (edge >= -0.03) return { seatId, type: 'call' }; // small tolerance for implied odds/fold equity the raw pot-odds number doesn't capture
      return { seatId, type: 'fold' };
    }

    // Nothing to call right now — either no bet has happened yet this
    // street, or (the big blind's own preflop option) this seat has
    // already matched the current bet exactly and gets to act again
    // anyway. Bet/raise for value when comfortably ahead, otherwise take
    // the free card. No bluffing: this only fires when the equity
    // estimate itself says it's ahead.
    const canAggress = legal.canBet || legal.canRaise;
    const aggressMin = legal.canRaise ? legal.minRaiseTo : legal.minBet;
    const aggressMax = legal.canRaise ? legal.maxRaiseTo : legal.maxBet;
    const betThreshold = 0.6 - positionEdge;
    if (canAggress && equity >= betThreshold) {
      const amountTo = spr <= SHOVE_SPR || equity >= 0.85 ? aggressMax : sizeToward(aggressMin, aggressMax, (equity - 0.5) * 2);
      return { seatId, type: legal.canRaise ? 'raise' : 'bet', amountTo };
    }
    if (legal.canCheck) return { seatId, type: 'check' };
    if (legal.canCall) return { seatId, type: 'call' };
    return { seatId, type: 'fold' };
  },
};
