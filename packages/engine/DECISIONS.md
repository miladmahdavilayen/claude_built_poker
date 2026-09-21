# Decisions

Every place the spec was ambiguous, silent, or where I found a genuine
correctness issue while property-testing, along with the resolution and
why. Ordered roughly by how much they matter.

## 1. Minimum raise after a short all-in is anchored to the last FULL bet, not to `currentBet`

The spec's own worked example (blinds 1/2, bet 10, raise to 25, all-in for
30) states the next minimum raise is **to 40**. Naively, "minimum raise =
currentBet + lastFullRaiseIncrement" gives `30 + 15 = 45`, not 40. The
only way to land on 40 is `lastFullBetAmount(25) + lastFullRaiseIncrement(15)`
— i.e. the anchor for sizing purposes is the last *full* bet/raise, not
the actual (possibly short-all-in-inflated) amount currently owed. I added
a second betting-state field, `lastFullBetAmount`, to track this
separately from `currentBet` (which still drives call amounts and the
reopening growth check). See `src/legalActions.ts`.

**Edge case this creates:** if several short all-ins cumulatively push
`currentBet` past `lastFullBetAmount + lastFullRaiseIncrement`, the raw
anchor formula could compute a `minRaiseTo` at or below what's already
owed — not a valid raise at all. I floor it at `currentBet + 1` in that
case. The spec doesn't cover this specific sub-case; property tests (2000
random hands/run) never produced a raise that was accepted below the
actual amount owed, which is the invariant that matters.

## 2. `getLegalActions` is turn-independent

The spec's own scenario tests 3 and 4 call `getLegalActions(A)` and
`getLegalActions(D)` and expect real numbers (e.g. `callAmount: 5`) even
though, at that point in the sequence, it is not literally that seat's
turn. I made `getLegalActions` a pure query based solely on the seat's own
facing-bet state (ignoring `betting.actingSeat` entirely) for any seat
that's `'active'` and the hand is `'in-hand'`. Turn enforcement lives
exclusively in `applyAction`'s `NOT_YOUR_TURN` check. This also matches
what a real UI wants: "if action gets back to me, what could I do."

## 3. Moving/dead button: a compacted occupied-seat ring, not literal seat-parking

The spec describes the button potentially "landing on an empty seat" and
the small blind being "dead" (posted by nobody) — the literal live-casino
behavior where a physical marker sits on a vacated chair. I implement the
mathematically equivalent, more common online-poker behavior instead: the
big blind always advances to the very next **occupied** seat (never skips
one, never repeats one — this is the invariant scenario test 12 actually
checks), and the small blind/button are always the two occupied seats
immediately preceding it. This never produces a "dead" small blind in my
implementation — every hand's blinds are always posted by a real seat.

I judged this a reasonable, standard interpretation because (a) it's what
most online implementations do, (b) it satisfies every assertion the spec
actually makes about this rule, and (c) a literal "phantom seat" marker
would add UI-only bookkeeping with no bearing on pot math, deferrable to
a later milestone if the M2 UI wants to animate the button visiting a
specific vacated chair.

One correctness subtlety I initially got wrong and fixed via testing
(`src/button.ts`): if the *previous* hand's big blind seat has itself left
the table since, you must **not** reset the rotation back to the lowest
occupied seat — you must advance from where that seat *was* to the next
occupied seat after it. Resetting would let a seat pay the big blind twice
within a couple of orbits, violating the hard invariant.

## 4. Antes are tracked separately from `committedThisHand`

Initially I added the ante directly into the payer's `committedThisHand`,
since that's the field pot-layering uses. This is wrong: pot layering
uses `committedThisHand` to determine contribution *levels* for
side-pot eligibility, and an ante paid by only one seat (BB ante) made
that seat's level differ from an otherwise-equal opponent's by exactly the
ante amount — spuriously creating a phantom one-chip side pot and (via the
uncalled-bet-return logic) even returning a chip that was never actually
uncalled. Antes are now tracked in a separate `TableState.anteTotal`
accumulator, deducted from the payer's stack but excluded from
`committedThisHand`, and folded into the main pot's amount directly in
`buildPots`. Found via the odd-chip scenario test (5b) failing with an
off-by-one pot total.

## 5. Uncalled-bet-return only collapses the simple (≤2 non-folded levels) case

The spec wants `uncalled-bet-returned` to fire before pots are formed
(scenario 7: heads-up, 200 vs. 80 → 120 returned) **and** wants exactly 3
real side pots for a three-way all-in with stacks 50/120/300 (scenario 6).
Naively applying "return top contributor's excess over the second-highest"
unconditionally collapses the three-way case to 2 pots, which contradicts
the spec's explicit "assert exactly 3 pots." I resolved this by only
applying the return when there are at most 2 *distinct contribution
levels among non-folded players* — the classic "one bet, one call-for-less"
shape. With 3+ distinct non-folded levels, every tier (including an
"uncontested" top tier with a single eligible seat) becomes a real,
awarded pot instead — which is standard poker-room behavior for genuine
multi-way all-ins with unequal stacks.

## 6. A folded seat's contribution can exceed every remaining contender's — orphaned pot tiers merge into the pot below

Folding is always legal, even when nothing is owed (the seat could check
for free instead). A property test found a real bug from this: a seat
raises, everyone else eventually goes all-in for less, and *later* that
original raiser folds anyway (facing no bet) — leaving their own
contribution as the single highest, with a "pot tier" above everyone
else's committed amount that literally nobody (folded or not) is eligible
to win. `buildPots` now merges any tier with zero eligible winners into
the nearest pot that does have eligible winners (backward into the last
pot built, or forward via a small carry if no pot exists yet) rather than
producing an unawardable pot — the money doesn't vanish and isn't returned
to the folder (they forfeited it by folding), it just flows to whichever
real contest it's adjacent to.

## 7. Straddle is a table-wide toggle, applied automatically every hand

The spec says "UTG *may* post a straddle" — a per-hand voluntary choice.
The engine's public API is only `startHand` / `getLegalActions` /
`applyAction`, with no channel for a discrete "does UTG want to straddle
this hand" decision. I treat `config.straddleEnabled` as always-on when
true: UTG straddles automatically every eligible hand (3+ handed; heads-up
never straddles). A server layer in a later milestone can trivially turn
this into a real per-hand choice by flipping the config bit before calling
`startHand`, or by not enabling it and instead layering a manual "extra
blind-like raise" via a normal `applyAction` raise call, without any
engine change.

## 8. Missed-blind tracking (`missedSmallBlind` / `missedBigBlind`) is not fully automated

The fields exist on `SeatState` per the spec's shape and are cleared when
a seat posts its blind, but the engine does not automatically detect a
seat that sat out through the blinds passing it and set these flags, nor
does it expose a discrete "post the missed BB, with a dead small blind
into the pot" choice — again, there's no seat-management API surface in
M1 (join/leave/sit-out are out of scope per the spec's own hard
boundaries). This is flagged as a known gap for the M3 server layer,
which owns seat lifecycle and can set these flags directly on the
`TableState` it constructs between hands.

## 9. Hand evaluator: `poker-evaluator`, wrapped with a combinatorial best-5-of-7 search, value sign inverted

`poker-evaluator` natively scores 5-card hands only (higher `value` =
stronger); it doesn't expose "best 5 of 7" or the winning 5 cards
directly. The wrapper (`src/evaluator.ts`) exhaustively evaluates every
5-card combination from the 5–7 given (at most C(7,5) = 21 calls),
picking the best raw `value`, and negates that value so the project-wide
convention — **lower value = stronger** — holds everywhere in the engine,
independent of whichever underlying library backs `HandEvaluator`.

## 10. Internal invariant violations still throw

The spec says the engine must never throw for illegal *caller* input —
verified by the fuzz tests (2000+500 malformed/out-of-turn actions per
run, always `{ ok: false }`, never an exception). A handful of `throw`
statements remain for conditions that indicate a genuine internal bug
(e.g. `buildPots` finding a pot whose amounts don't sum to total
contributions, or `evaluate()` receiving fewer than 5 cards) — these are
defensive assertions unreachable from any external input, not error
handling for bad calls, and the property tests (2000 fully-random legal
hands/run) never trip them.

## 11. Dealing order

Hole cards are dealt one at a time, two passes, starting at the small
blind seat and proceeding clockwise through every seat dealt into the
hand (skipping seats not playing this hand) — matching how cards are
physically dealt at a real table, rather than dealing two cards at once
per player. This only affects *which specific card* a fixed test deck
assigns to which seat, never game logic; scenario tests document the
resulting mapping explicitly.

## 12. `SeatState.status` semantics between hands

Outside of a hand (`phase !== 'in-hand'`), a seat's status carries over
from the previous hand. `startHand` resets any `'folded'` or `'all-in'`
seat back to `'active'` (or `'sitting-out'` if its stack hit zero) before
dealing the next hand, and requires at least two `'active'` seats with a
positive stack to proceed (`NOT_ENOUGH_PLAYERS` otherwise). `'sitting-out'`
and `'empty'` seats are simply skipped for dealing and for the button/blind
rotation (see decision 3) — this is the natural, minimal semantics given
seat management itself is out of M1's scope.
