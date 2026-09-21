# Rules

pokerclause implements standard No-Limit Texas Hold'em, played to the
rules a live cardroom or the TDA (Tournament Directors Association) rules
would recognize. This is a summary; the authoritative, exhaustively-tested
implementation is `packages/engine` — see `packages/engine/README.md` for
the full public API and `packages/engine/DECISIONS.md` for every
ambiguous-rule call made and why.

## Table setup

- 2–9 seats, configurable small blind, big blind, and optional BB ante.
- Button rotates one live seat per hand, moving-button style: it always
  advances to the next live (dealt-in) seat and never repeats or skips
  one, even across seats sitting out.
- **Heads-up**: the button *is* the small blind — posts SB, acts first
  preflop, acts last every street after.
- **Dead button / missed blinds**: handled per standard rules — a seat
  that missed its blind must post before being dealt in again (or wait);
  the button can land on a seat with no eligible big blind behind it,
  producing a "dead" button hand.
- Straddles are supported when enabled at the table level.

## Betting

- Standard no-limit structure: fold / check / call / bet / raise, with
  bet/raise expressed as "raise **to**" a total, not "raise **by**."
- **Short all-in reopening**: an all-in for less than a full raise does
  **not** reopen the action for a player who's already acted and isn't
  facing a full raise increment — they may only call or fold. A player who
  hasn't acted yet this round can still raise, with the minimum sized off
  the last **full** bet/raise, not the short all-in. This holds correctly
  even through several short all-ins stacked in a row (cumulative
  reopening) — see the engine README's worked example.
- Round closure, pot construction (including side pots via contribution
  layering), and split-pot odd-chip award order all follow standard rules.

## Showdown

- Standard hand rankings; ties split the pot with odd chips awarded by
  standard high-card-of-suit-doesn't-matter, closest-to-the-button rules
  (see the engine's showdown implementation, `packages/engine/src/showdown.ts`,
  and its regression tests for the exact award-order behavior).
- Hole cards are only ever revealed to other players at a genuine showdown
  (or an all-in runout that reaches showdown) — never on a fold, and never
  to anyone before that point. This is enforced server-side by the
  projection layer (`packages/shared/src/projection.ts`), not just hidden
  in the UI.

## Fairness

Every hand's deck is dealt using a commit-reveal scheme so the shuffle
can be independently verified after the fact — see [FAIRNESS.md](./FAIRNESS.md).

## Chips

Play money only — no real-money value, no cash-out to real currency. Every
chip movement (buy-in, cash-out, pot win, rake, admin adjustment) is
recorded as a balanced double-entry ledger row; the system enforces that
every entry set sums to zero.

## What's not yet implemented

- **Run-it-twice**: the `runItTwiceEnabled` table setting exists but has
  no behavior behind it yet.
- **Table stakes variants** (pot-limit, fixed-limit): not implemented —
  no-limit only.
- **Tournament structure** (blind levels, eliminations, payouts): not
  implemented — this is a cash-game app.
