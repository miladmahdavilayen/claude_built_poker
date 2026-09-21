import type { Draft, MutableSeat } from './table.js';
import type { GameEvent, Pot } from './types.js';

/**
 * Returns any uncalled portion of the top bet to its owner, before pots
 * are formed. The top contributor (by final committedThisHand, folded or
 * not) gets back the excess over the second-highest contribution among
 * everyone else (folded or not) — since a folded player's locked-in
 * contribution still counts as "called" up to their fold point.
 *
 * This only applies to the simple case: at most two distinct contribution
 * levels among non-folded players (the classic "raise gets no full call"
 * shape). A genuine multi-way all-in with 3+ distinct non-folded levels
 * (e.g. stacks 50/120/300, all in) is NOT collapsed this way — every tier
 * becomes a real side pot instead, including an "uncontested" top pot
 * with a single eligible seat, which is standard poker-room behavior and
 * what buildPots already produces correctly on its own. See DECISIONS.md.
 *
 * Requires at least two seats with committedThisHand > 0. With only one,
 * "second-highest" would default to 0 and this would refund the sole
 * contributor's ENTIRE bet to zero — which is wrong whenever another
 * non-folded contender is still in the hand with a genuine (if zero)
 * stake, e.g. an all-in whose whole stack was consumed by the ante before
 * they could post a blind. A lone contributor's bet just becomes its own
 * (possibly uncontested) pot instead; nothing needs to be "returned".
 */
export function returnUncalledBet(draft: Draft): GameEvent[] {
  const contributors = draft.seats.filter((s) => s.committedThisHand > 0);
  if (contributors.length <= 1) return [];
  const nonFoldedLevels = new Set(contributors.filter((c) => c.status !== 'folded').map((c) => c.committedThisHand));
  if (nonFoldedLevels.size > 2) return [];
  let top: MutableSeat | null = null;
  for (const s of contributors) {
    if (top === null || s.committedThisHand > top.committedThisHand) top = s;
  }
  if (top === null) return [];
  let secondMax = 0;
  for (const s of contributors) {
    if (s.seatId === top.seatId) continue;
    if (s.committedThisHand > secondMax) secondMax = s.committedThisHand;
  }
  const excess = top.committedThisHand - secondMax;
  if (excess <= 0) return [];
  top.committedThisHand -= excess;
  top.committedThisStreet = Math.max(0, top.committedThisStreet - excess);
  top.stack += excess;
  if (top.status === 'all-in' && top.stack > 0) {
    top.status = 'active';
  }
  return [{ type: 'uncalled-bet-returned', seatId: top.seatId, amount: excess }];
}

/**
 * Builds pots by contribution layering. Levels are derived from ALL
 * contributors (folded or not) so no chip is ever left unassigned;
 * eligibility at each level is restricted to non-folded contributors who
 * met that level.
 */
export function buildPots(draft: Draft): GameEvent[] {
  const contributors = draft.seats.filter((s) => s.committedThisHand > 0);
  const levels = [...new Set(contributors.map((c) => c.committedThisHand))].sort((a, b) => a - b);

  // A player may fold voluntarily even with no bet facing them (canFold is
  // always legal). If that player had raised earlier and contributed more
  // than anyone left in the hand, their tier has no eligible winner at
  // all — the money isn't returned to them (they folded, forfeiting it)
  // and nobody else reached that level either. It's merged into the
  // nearest pot that DOES have eligible winners: backward into the last
  // pot built so far, or forward (via carryForward) if no pot exists yet.
  // See DECISIONS.md.
  const pots: Pot[] = [];
  let carryForward = 0;
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contributors) {
      amount += Math.min(c.committedThisHand, level) - Math.min(c.committedThisHand, prev);
    }
    prev = level;
    if (amount <= 0) continue;
    const eligibleSeatIds = contributors
      .filter((c) => c.status !== 'folded' && c.committedThisHand >= level)
      .map((c) => c.seatId);
    if (eligibleSeatIds.length === 0) {
      if (pots.length > 0) {
        pots[pots.length - 1]!.amount += amount;
      } else {
        carryForward += amount;
      }
      continue;
    }
    pots.push({ index: pots.length, amount: amount + carryForward, cappedAt: level, eligibleSeatIds });
    carryForward = 0;
  }

  // Antes aren't part of any seat's calling/raising commitment (see
  // DECISIONS.md) — fold the collected ante pool into the main pot.
  if (draft.anteTotal > 0 && pots.length > 0) {
    pots[0]!.amount += draft.anteTotal;
  }

  const totalContributed = contributors.reduce((sum, c) => sum + c.committedThisHand, 0) + draft.anteTotal;
  const totalInPots = pots.reduce((sum, p) => sum + p.amount, 0);
  if (totalInPots !== totalContributed) {
    throw new Error(
      `unreachable: pot total ${String(totalInPots)} does not match contributions ${String(totalContributed)}`,
    );
  }
  for (const pot of pots) {
    if (pot.eligibleSeatIds.length === 0) {
      throw new Error(`unreachable: pot ${String(pot.index)} has no eligible winners`);
    }
  }

  draft.pots = pots;
  return [{ type: 'pots-formed', pots }];
}
