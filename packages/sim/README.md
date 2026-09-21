# @pokerclause/sim

A simulation and fuzzing harness for `@pokerclause/engine`: it plays
hundreds of thousands to millions of bot-vs-bot hands through the real
engine, checks a battery of invariants after every single state
transition (not just once per hand), tracks coverage of the specific
poker edge cases that break engines, runs statistical sanity checks over
the aggregate results, verifies every hand replays byte-identically from
its action log, and — on any failure — writes a self-contained JSON repro
file with a one-line command to reproduce it.

## Quick start

```bash
pnpm --filter @pokerclause/sim sim -- --hands 100000 --seats 6 --seed abc123
pnpm --filter @pokerclause/sim sim -- --hands 1000000 --seats random --mix adversarial --workers 4
pnpm --filter @pokerclause/sim sim:repro -- --file sim-failures/<name>.json
pnpm --filter @pokerclause/sim sim:golden -- --update
pnpm --filter @pokerclause/sim test         # unit + small-scale regression tests, including the golden corpus
```

(The `--` before the flags is pnpm's own separator for passing arguments
through to the underlying script.)

## CLI flags (`pnpm sim`)

| Flag | Default | Meaning |
|---|---|---|
| `--hands` | `10000` | Total hands to play. |
| `--seats` | `random` | Fixed seat count (2-9) or `random` (a fresh table each rebuild picks 2-9). |
| `--seed` | time-based | Master seed. **Same seed ⇒ byte-identical run**, including with `--workers`. |
| `--mix` | `balanced` | `balanced` \| `adversarial` \| `passive` \| `custom`. See below. |
| `--workers` | `1` | Split hands across N worker_threads with derived seeds (`<seed>:worker:<i>`), merged at the end. |
| `--verbose` | off | Print progress every 10,000 hands. |
| `--fail-fast` | `true` | Stop the run on the first failure. Pass `--fail-fast false` to keep going and collect every failure. |
| `--repro-dir` | `sim-failures` | Where repro files are written. |
| `--out` | — | Reserved for redirecting the summary to a file (currently the summary always also prints to stdout). |

## Architecture

```
src/
  bots/            8 policies (see below) behind the BotPolicy interface
  projection.ts    projectSeatView() — what a bot is allowed to see
  handRunner.ts    plays one hand start-to-finish, checking invariants after every transition
  churn.ts         between-hand table churn: busts, rebuys, new players, sit-out/in, leaves, blind raises
  invariants.ts    the correctness checks (see below)
  observeCoverage.ts   the 21 coverage counters
  stats.ts         statistical sanity checks over the aggregate run
  replay.ts        replayHand() — re-derives a hand from {initialState, deck, actionLog}
  reproWriter.ts    writes sim-failures/<timestamp>-<code>.json on any failure
  harness.ts       ties it all together: churn -> deal -> run -> replay -> observe, per hand
  cli.ts           the `pnpm sim` entry point (single- and multi-worker)
  reproCli.ts      the `pnpm sim:repro` entry point
  golden.ts / goldenCli.ts   the 200-hand golden corpus generator/validator
```

### Bot policies

`random-legal`, `calling-station`, `nit`, `maniac`, `shove-monkey`,
`check-fold`, `short-stacker`, and `adversarial` (see `src/bots/`). Every
bot only ever sees a `SeatView` (via `projectSeatView`), never the raw
`TableState` — it cannot see another seat's hole cards or the undealt
deck. `tests/projection.test.ts` asserts this directly, including a
belt-and-suspenders check that no other seat's card string appears
anywhere in the serialized view.

`adversarial` biases toward exactly the situations that break poker
engines: raises pinned to `minRaiseTo`/`maxRaiseTo`, all-ins whenever
raising is legal at all (which is what produces short all-ins, chains of
them, and 3+ distinct all-in levels once several such bots share a table
with varied stacks from churn). The one thing a `BotPolicy` never does is
attempt an intentionally illegal action — that's the harness's job (see
`handRunner.ts`'s `minRaiseTo - 1` probe below), so a policy's `decide()`
always returns what it actually wants to do.

**Deliberately-illegal probe.** Separately from any bot's decision, the
harness itself — with a tunable probability, higher under `--mix
adversarial` — attempts a raise to `minRaiseTo - 1` right before letting
the bot act for real, and asserts the engine rejects it with
`ILLEGAL_AMOUNT`. This never touches the live hand's state (a rejected
`applyAction` call returns `{ ok: false }` without mutating anything), so
it's a pure probe layered on top of the real decision.

### Table churn

Runs between every hand (`churn.ts`): busted seats rebuy (random 40-100×
current BB) or leave; empty seats occasionally seat a new player; active
seats occasionally sit out, and sitting-out seats occasionally sit back
in (this is the simulation-layer approximation of "post the missed blind"
vs. "wait for the BB" — M1's engine doesn't automate missed-blind
detection itself, see its `DECISIONS.md` #8, so the harness models the
*decision* directly rather than the engine tracking it); seats leave
mid-orbit independent of busting (forcing the moving-button algorithm to
skip a vacated seat); and blinds occasionally double, capped at a big
blind of 1,000,000 to keep chip totals well clear of
`Number.MAX_SAFE_INTEGER` over a long table lifetime.

Every ~200-2000 hands (randomized) the harness fully tears down and
rebuilds the table from scratch — fresh seat count (2-9 if `--seats
random`), fresh ante/straddle/blind configuration, fresh buy-ins — so a
long run exercises many independent table lifetimes, not one table
drifting forever.

### Invariants (checked after every transition, not just per hand)

`invariants.ts` implements all 19 from the spec: chip conservation,
no negative stacks/pots, exact-52-card accounting, board/burn length
matching the street, `currentBet` equal to the max `committedThisStreet`,
`lastFullRaiseIncrement > 0` whenever there's a bet, an all-in seat never
being the acting seat, `minRaiseTo <= maxRaiseTo`, min-raise sizing
anchored to the last *full* raise (re-derived independently across each
transition and compared against the engine's own answer), pot shape
(non-empty eligibility, no folded seat eligible, strictly-ascending
`cappedAt`), side-pots-before-main award order, payouts equal to
contributions, a bounded action count per hand, and the engine never
throwing for a bad *caller* input (wrapped so that even an unexpected
internal throw is captured as a structured failure with a full repro,
never a bare crash).

One invariant needed a genuine reinterpretation during development: pot
*count* can't be bounded by "one pot per distinct non-folded contribution
level" — a **folded** player's contribution level can still anchor a real,
awardable pot tier for the non-folded players above it (see
`checkPotCountBound`'s doc comment and engine `DECISIONS.md` #6).

## Failure output and shrinking

On any failure, `reproWriter.ts` writes
`sim-failures/<timestamp>-<code>.json` containing the master seed, the
hand's derived seed, the full hand-start `TableState`, the exact deck,
the complete action log up to the failure, the violation (with
actual/expected), and — this is the important part —
`shrunk: { stateBeforeFailingAction, failingAction }`.

**Why there's no separate search-based shrinking step:** `TableState` is
a complete, self-sufficient snapshot, so the state immediately before the
failing transition plus the single action that triggered it is *already*
a minimal, one-action repro — nothing needs to be searched for or
simplified further. `pnpm sim:repro --file <path>` re-applies exactly
that one action (or re-runs `startHand` when the failure was detected
right after dealing) to that one state and re-checks the same invariants,
reporting either "STILL FAILS" (with the violation) or "appears to be
FIXED."

Every repro that exposed a real engine bug during this milestone's
development was turned into a permanent regression test in
`packages/engine/tests/regressions/` — see that directory and the
project-level report for the full list.

## Reading the coverage table

21 counters (`observeCoverage.ts`), one per spec-required edge case. A
run's coverage table should have **zero** zero-count entries for a
DoD-qualifying run (100k+ hands with a healthy adversarial mix). If one
is stuck at zero, the fix is almost always to tune `adversarial`'s
weights or churn's probabilities to produce that situation more often —
never to weaken or delete the counter.

## Known finding: button-position fairness under heavy churn

The statistical check `button-position-uniformity` (chi-square of
observed vs. occupancy-weighted-expected button assignments per physical
seat) can fail on long, heavily-churned runs, consistently in the same
direction: low seat numbers get the button slightly more often than a
perfectly uniform rotation would predict.

Root cause: M1's moving-button algorithm (`assignButtonAndBlinds`)
advances the big blind to the next *occupied* seat via `nextInRing`,
which falls back to the lowest occupied seat when the previous hand's BB
seat has since been vacated (`ring.find(s => s > from) ?? ring[0]`). This
is mathematically the correct "wrap around a fixed circular seating"
computation, and a table with a **stable** seat count rotates through
every position with exact uniformity (provably — the button advances by
exactly one ring position every hand). The bias only appears when seats
are added or removed between hands often enough for this fallback to
fire repeatedly, which is a much higher churn rate than any real cash
game sees, but is exactly what this harness's `churn.ts` does on purpose.

This is a genuine, if narrow, structural property of the engine's ring-
compaction design (documented in its `DECISIONS.md` #3) — not a
newly-introduced bug, and not something the harness should paper over by
loosening the check's threshold. It's flagged here, and in the project
report, as something worth a deliberate decision (either accept it as a
known trade-off given how rare this churn pattern is in real usage, or
revisit the fallback rule) before M3 builds a live server on top of the
same algorithm.
