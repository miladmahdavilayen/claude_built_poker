# Fairness

pokerclause uses a standard **commit-reveal** scheme so nobody — including
the person running the server — can pick a deck order after seeing who's
at the table or what they've done. The implementation lives in
`apps/server/src/rng/commitReveal.ts`; this document explains the scheme
itself and how to check any hand yourself.

## The scheme

1. **Before any card is dealt**, the server generates a random 32-byte
   `serverSeed` and computes `commitment = SHA256(serverSeed)`.
2. The commitment is sent to every seated player and spectator as soon as
   the hand starts — it's the `handCommitment` field on the table state
   (`ProjectedTableState.handCommitment`), shown in the client as
   "Fairness commitment: …" at the top-left of the felt. This is the
   server's unbreakable promise: whatever `serverSeed` it reveals later
   must hash to this exact value, or it's lying.
3. Every seated player has a `clientSeed` (auto-generated on account
   creation, currently not player-editable in the UI — see "Known
   limitation" below).
4. The deck order is derived as:
   ```
   derivedSeed = HMAC-SHA256(key = serverSeed, message = clientSeeds.join('') + ':' + handNumber)
   deck = shuffle(freshDeck(), seededSource(derivedSeed))
   ```
   `seededSource` (from `@pokerclause/rng`) is an HMAC-SHA256 counter-mode
   deterministic random source — the same primitive the simulation harness
   uses for reproducible test runs — and `shuffle` is a Fisher-Yates
   shuffle with rejection sampling (no modulo bias).
5. **After the hand**, `serverSeed` is revealed via the fairness endpoint.

Because `serverSeed` is committed to before anyone's `clientSeed` is known
to have mattered for this specific hand, and the deck derivation mixes in
every seated player's `clientSeed`, no single party — not the house, not
any one player — can unilaterally choose or predict the outcome.

## Verifying a hand

```
GET /fairness/:handId
```

Returns, once the hand is over:

```json
{
  "handId": "...",
  "revealed": true,
  "valid": true,
  "commitmentMatches": true,
  "deckMatches": true,
  "commitment": "sha256 hex...",
  "serverSeed": "hex...",
  "clientSeeds": ["...", "..."],
  "handNumber": 42,
  "dealtDeck": ["As", "Kd", ...],
  "derivedDeck": ["As", "Kd", ...]
}
```

To verify independently of trusting this endpoint's own math, recompute
yourself:

```
SHA256(serverSeed) should equal commitment
HMAC-SHA256(key=serverSeed, msg=clientSeeds.join('')+':'+handNumber)
  fed into the same seeded-shuffle algorithm should equal dealtDeck
```

`pnpm --filter @pokerclause/server verify-hand` (see
`apps/server/src/rng/verifyHandCli.ts`) does exactly this from the
command line against a hand record, using the exact same
`packages/rng` code the server itself uses — so "verify" isn't just
re-running the server's own claim through the server's own code with no
independent check; it's the same well-tested shuffle algorithm the
`packages/rng` test suite validates on its own (chi-square uniformity,
golden vectors, full-permutation coverage).

## Known limitation

The `commitment` is now correctly published to clients *before* the hand
plays out (this was fixed during development after being caught mid-build
— see the corresponding note in the top-level DECISIONS.md and the
`handCommitment` field's doc comment in
`packages/shared/src/types.ts`). What's still missing relative to a fully
airtight scheme: **the UI has no control for a player to set/rotate their
own `clientSeed`.** One is generated automatically per account, but a
player who wants to actively participate in a specific hand's randomness
(rather than just later verify it) can't currently change it from the
client — only via the (unauthenticated-from-the-UI) fact that it's stored
per-user server-side. This doesn't weaken the *verifiability* of any
individual hand (the math above still holds and is still checkable), but
it does mean the "every player contributes entropy they control" property
is weaker in practice than the scheme's design allows for.
