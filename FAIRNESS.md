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

## Checking a hand at the table

Players don't need any of the details below. After a hand, **Verify hand
fairness** opens a short check in plain words, in three steps: sealed
before the deal, shuffled with everyone's seed, opened and re-checked.
- **Checked on the player's device:** the browser does the check itself and
  doesn't take the server's word for it (`apps/web/src/fairness.ts`).
  - It hashes the revealed server seed and compares it with the fairness
    commitment shown before the deal.
  - It re-derives the whole deck with the same HMAC counter-mode stream and
    unbiased Fisher-Yates shuffle as `packages/rng`, and compares it card by
    card with the deck that was dealt.
  - It uses its own SHA-256/HMAC, not the browser's Web Crypto. Web Crypto
    only exists on https pages (and localhost), and the check has to work
    wherever the table is open.
- **What it shows:** the rebuilt top of the deck, with this hand's board and
  your cards highlighted. The raw numbers sit under "Check it yourself".
- **Kept honest:** `apps/server/tests/browserFairness.test.ts` checks the
  hashing against the standard test vectors. It also checks that the browser
  and server agree hand after hand, and that both catch a tampered deck or
  commitment.

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
