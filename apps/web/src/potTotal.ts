import type { ProjectedTableState } from '@pokerclause/shared';

/**
 * The true "live" pot total at any point in a hand. The engine only
 * builds `state.pots` (with its side-pot breakdown) once the hand
 * concludes — showdown or everyone-but-one folding — so summing `pots`
 * mid-hand always reads zero (this was silently breaking the "1/2 pot"
 * and "Pot" bet-sizer preset buttons, which always resolved to 0, clamped
 * up to the min bet, during live betting; see DECISIONS.md).
 *
 * Every seat's `committedThisHand` plus any ante collected always equals
 * the real total in the middle, both mid-hand and after the hand
 * completes — the engine adjusts `committedThisHand` for any uncalled-bet
 * return before building pots, so this stays correct in both cases
 * without needing to branch on hand phase.
 */
export function livePotTotal(state: Pick<ProjectedTableState, 'seats' | 'anteTotal'>): number {
  return state.seats.reduce((sum, s) => sum + s.committedThisHand, 0) + state.anteTotal;
}
