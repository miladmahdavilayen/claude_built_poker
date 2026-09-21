# @pokerclause/engine

A standalone, dependency-light TypeScript implementation of No-Limit Texas
Hold'em as a deterministic, pure state machine. No I/O, no network, no
randomness of its own — the caller injects a shuffled deck and gets back a
new state plus a list of events describing what happened.

## Install / workspace

This package lives at `packages/engine` in the `pokerclause` pnpm
workspace. From the repo root:

```
pnpm install
pnpm --filter @pokerclause/engine test
pnpm --filter @pokerclause/engine typecheck
pnpm --filter @pokerclause/engine lint
pnpm --filter @pokerclause/engine coverage
```

or, from the workspace root, `pnpm test` / `pnpm typecheck` / `pnpm lint`
run it (and every other workspace package) via `pnpm -r`.

## Public API

```ts
import {
  startHand, getLegalActions, applyAction,
  createTableState, createDefaultEvaluator,
  fullDeck, isValidDeck, rankOf, suitOf, rankIndex,
} from '@pokerclause/engine';

function startHand(state: TableState, deck: readonly Card[]): EngineResult;
function getLegalActions(state: TableState, seatId: number): LegalActions;
function applyAction(state: TableState, action: PlayerAction): EngineResult;

type EngineResult =
  | { ok: true; state: TableState; events: GameEvent[] }
  | { ok: false; error: EngineError };
```

None of these three functions ever throw for a bad *caller* input — illegal
actions, unknown seats, wrong turns, malformed amounts, and so on all come
back as `{ ok: false, error: { code, message } }`. (Internal invariant
violations — e.g. a pot-accounting bug — still throw, since those indicate
a real defect in the engine, not a bad caller input; see the "never
throws" note in DECISIONS.md.)

`getLegalActions` is a **pure query**, independent of whose turn it
actually is: it reports what a seat *could* legally do right now given its
own facing-bet state, so a caller can preview "if action gets back to seat
X, what can they do." Turn order itself is enforced only by `applyAction`
(`NOT_YOUR_TURN`). This is what lets a UI (or a test) inspect a
not-currently-acting seat's situation, which the spec's own reopening-rule
scenarios rely on directly (see the "short all-in" scenario tests).

`createTableState(config, players)` and `fullDeck()` are convenience
constructors for building a fresh, unstarted table and a fixed-order 52
card deck respectively — neither does any I/O or randomness; shuffling is
entirely the caller's responsibility (inject any permutation you like,
including a fixed one for deterministic tests).

The hand evaluator is wrapped behind `HandEvaluator` (`src/evaluator.ts`)
so the underlying library (`poker-evaluator`) can be swapped later without
touching game logic:

```ts
interface HandEvaluator {
  evaluate(cards: readonly Card[]): { value: number; name: string; bestFive: Card[] };
}
```

**Convention: lower `value` = stronger hand.** `poker-evaluator`'s own
convention is the opposite (higher = stronger); the wrapper negates it so
this package is internally consistent regardless of which evaluator
backs it.

## Core types

See `src/types.ts` for the full, authoritative definitions. Shape follows
the spec closely, with a small number of additive, engine-internal
bookkeeping fields on `TableState` (`lastBigBlindSeat`, `straddleSeat`,
`allInRevealed`, `anteTotal`) and on `SeatState` (`lastActedAtBet`) needed
to implement the button rotation and the short-all-in reopening rule
correctly without re-deriving history on every call. Every one of these is
documented in `DECISIONS.md`.

`GameEvent` is a discriminated union covering everything a future UI would
need to animate a hand: `hand-started`, `ante-posted`, `blinds-posted`,
`cards-dealt`, `action-taken`, `street-dealt`, `betting-round-closed`,
`uncalled-bet-returned`, `pots-formed`, `showdown-reveal`, `pot-awarded`,
`hand-complete`. Every state transition emits events; the engine never
mutates its input `TableState` — every function returns a brand new one
(see `src/table.ts`'s `toDraft`/`fromDraft`, which deep-clone on the way
in and out of every mutation pass).

## The two rules this spec calls out as commonly botched

### Heads-up position

Implemented in `src/button.ts` / `src/hand.ts`. In heads-up, the button
**is** the small blind: it posts the small blind, acts first preflop, and
acts last postflop. This falls out naturally from the engine's general
"anchor and walk the ring" design (see below) rather than being
special-cased in the betting logic — heads-up is only special-cased in
`assignButtonAndBlinds` itself, where the button and the small blind are
assigned to the same seat.

### Short all-in reopening and minimum-raise sizing

Implemented in `src/legalActions.ts` and `src/betting.ts`. This follows
the TDA (Tournament Directors Association) rules' treatment of incomplete
raises (TDA Rule, "Wagers", the incomplete/all-in raise provisions): an
all-in wager smaller than a full raise does not reopen the betting for a
player who has already acted and isn't facing a full raise — that player
may only call or fold. A player who has **not yet acted** this round may
still raise, with the minimum measured from the last **full** bet/raise.

Two pieces of engine state drive this, both reset at the start of every
betting round:

- `betting.lastFullRaiseIncrement` — the size of the largest FULL
  bet/raise increment this street.
- `betting.lastFullBetAmount` — the `currentBet` level established by
  that last full bet/raise (which can be *less* than the actual
  `currentBet` once a short all-in raise has bumped the amount owed
  without itself being "full").

The minimum legal raise is always `lastFullBetAmount + lastFullRaiseIncrement`
(floored at `currentBet + 1`, to stay well-formed in the pathological case
where several short all-ins have cumulatively pushed `currentBet` past
that anchor — see DECISIONS.md). This reproduces the spec's own worked
example exactly: blinds 1/2, a raise to 10, a raise to 25 (full,
increment 15), then an all-in to 30 (short, +5 < 15) — the next minimum
raise is to **40** (`25 + 15`), not `30 + 15 = 45`.

Whether a given seat is currently reopened is computed lazily from a
per-seat snapshot, `SeatState.lastActedAtBet` — the `currentBet` value at
the moment that seat last completed a voluntary action this street:

```
reopened(seat) = !seat.hasActedThisRound
              || (currentBet - seat.lastActedAtBet) >= lastFullRaiseIncrement
```

Because this is a single growth comparison against an increment that only
changes on full raises, it transparently handles **cumulative** short
all-ins too: several short raises in a row, none individually full, still
reopen a seat once their combined growth since that seat's last action
reaches a full increment — without any special-cased "sum the short
raises" bookkeeping.

## Definition of done

- `pnpm test` — 35 tests, all green (evaluator, all 14 spec scenarios,
  property tests over 2000 random legal-action sequences per run, and
  fuzz tests over 2000+500 malformed-action sequences per run).
- `pnpm typecheck` — clean, strict mode, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`.
- `pnpm lint` — clean; `any` and `Math.random` are hard ESLint errors.
- `pnpm coverage` — ≥90% statement/line/function coverage on `src/`.

See `DECISIONS.md` for every assumption made where the spec was ambiguous.
