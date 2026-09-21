# pokerclause

A self-hosted, multiplayer No-Limit Texas Hold'em web app: a server-authoritative
game engine, real-money-free (play money) chip economy, provably-fair shuffling,
and a React client. Built as a pnpm monorepo.

## Project layout

```
packages/
  engine/    Pure, dependency-light NLH rules engine (no I/O, no randomness inside).
  rng/       Deterministic + cryptographic shuffling (Fisher-Yates, HMAC-SHA256 DRBG).
  sim/       Bot-driven simulation harness that stress-tests the engine (invariants,
             replay verification, coverage). 1,000,000-hand validated, zero failures.
  shared/    Types/schemas/anti-cheat projection shared between server and client.
apps/
  server/    Fastify + Socket.IO server: auth, persistence, live table runtime,
             RNG commit-reveal fairness, chip ledger, WebRTC signaling relay,
             computer-player (bot) seats.
  web/       React 19 + Vite client: lobby, table, seats, betting, chat,
             waitlist, private tables, peer-to-peer voice/video, an
             end-to-end Playwright suite.
```

Each package/app has its own README and/or DECISIONS.md going into more depth
(`packages/engine/README.md` and `DECISIONS.md` in particular document the full
rules implementation and every ambiguous-rule call made along the way).

## Quickstart — Docker Compose (recommended)

```bash
cp .env.example .env
# edit .env: set JWT_SECRET (see the comment in .env.example for how to generate one)
docker compose up --build
```

Then, once the containers are up, run the database migration once (the schema
isn't auto-migrated on boot, by design — see DECISIONS.md):

```bash
docker compose exec server pnpm db:migrate
docker compose exec server pnpm db:seed   # optional: admin + test accounts
```

Open http://localhost:5173. The server listens on http://localhost:4000.

Two public tables ("Micro Stakes 1/2", "High Stakes 5/10") are created
automatically on every server boot — see `seedDefaultTables` in
`apps/server/src/index.ts`. `docker compose exec server pnpm db:seed` additionally
seeds three real Postgres accounts for testing: `admin@pokerclause.local`,
`alice@pokerclause.local`, `bob@pokerclause.local` (all password `password123`,
except admin: `admin12345`).

> Docker Compose has not been run in the development sandbox this project was
> built in (no Docker daemon available there) — the compose file, Dockerfiles,
> and env wiring were written and reviewed carefully, but treat the first
> `docker compose up --build` as the real first test of that path and report
> back if something doesn't line up.

## Quickstart — local dev (no Docker)

Requires Node.js 22+ and pnpm.

```bash
pnpm install
```

Without `DATABASE_URL` set, the server falls back to an in-memory store — no
Postgres needed for local development, but nothing persists across restarts
(a deliberate simplification; see DECISIONS.md).

```bash
# terminal 1
JWT_SECRET=dev-secret-change-me PORT=4000 pnpm --filter @pokerclause/server dev

# terminal 2
VITE_API_URL=http://localhost:4000 pnpm --filter @pokerclause/web dev
```

Open http://localhost:5173, click "Play as guest", and you're seated at a
live poker table.

## Running the test suites

```bash
pnpm -r test         # every package's unit/integration tests
pnpm -r typecheck
pnpm -r lint
```

The simulation harness (`packages/sim`) can additionally run a large
bot-driven validation pass — see `packages/sim/README.md` (or its CLI
`--help`) for `pnpm --filter @pokerclause/sim start -- --hands 1000000`.

There's also a real end-to-end suite that drives the actual React UI in a
headless Chromium against the actual server (both started automatically):

```bash
cd apps/web
npx playwright install chromium   # one-time browser download
pnpm e2e
```

It covers a full two-player hand played through real clicks with a
mid-hand hole-card-leak check, a full hand driven by real bets/raises on
every street from preflop through the river, private-table invite-code
enforcement, the waitlist, table position labels, a session surviving a
hard page reload, no-Google-configured graceful degradation, the action
bar staying pinned in view at an extreme short browser-window height, the
"Pot"/"1/2 pot" bet-sizer presets reflecting the real live pot, chip
visuals for SB/BB/street bets landing in front of the right seat, a solo
player adding a computer opponent and playing a full hand against it with
no second human involved, and — using Chromium's fake-media-device flags,
no real camera/mic needed — two seated players actually establishing a
peer-to-peer WebRTC voice/video connection and each seeing the other's
video rendered directly on their seat. See `apps/web/tests/e2e/`.

Seats show their table position (UTG, HJ, CO, SB, BB — the button seat
gets the dealer disc instead of a redundant "BTN" text badge), computed
from whoever's actually dealt into the current hand and rotating with the
button exactly like the engine's own button/blind assignment does — see
`apps/web/src/positionLabels.ts`. A table's very first hand assigns that
initial button fairly, via a real high-card draw across everyone dealt
in, rather than defaulting to the lowest seat id — see DECISIONS.md.

Chip amounts (blinds, any other street bet, and the pot) render as
color-coded chip-stack graphics using the standard casino denomination
ladder (white $1, red $5, blue $10, green $25, black $100, and upward),
not just plain numbers — bet chips sit on the felt in front of the
associated seat, swept away and redrawn fresh each street, same as real
chips would be. See `apps/web/src/chips.ts` and DECISIONS.md.

## Computer players

Any empty seat can be filled with a computer opponent instead of waiting
for another human — useful for practice, or just playing solo for fun.
Click **"+ Add bot"** on an empty seat, pick a persona and a buy-in, and
it plays on its own, real-time, with a randomized 1–6 second "thinking"
delay before each action, so it doesn't feel instant or robotic. A table
needs at least one real human seated
before it deals a hand at all — a table left with only bots never deals
itself into an empty room, so it isn't quietly burning server resources
for no one.

Seven personas are selectable (`apps/web/src/botPersonas.ts` /
`SELECTABLE_BOT_POLICIES` in `apps/server/src/game/liveTable.ts`), reusing
the exact same bot decision logic the 1,000,000-hand simulation harness
validated — The Nit, Calling Station, Maniac, Shove Monkey, Short
Stacker, Pushover, and Wildcard. (`adversarial`, the eighth policy in
`packages/sim`, is deliberately excluded here — it's a QA tool built to
probe engine edge cases, not a fun opponent.)

Computer players are play chips only: no real `userId`, never touch the
chip ledger, and their buy-in isn't drawn from anyone's balance — see
DECISIONS.md for why, and for the two real bugs (not just design
decisions) that got found and fixed while building this: a
double-broadcast redundancy in `join-table`, and a bug in `Seat.tsx`
where a bot's seat rendered as permanently empty because its (correctly
`null`, since a bot isn't a real user) `playerId` was being used as an
"is this seat empty" check.

## Voice & video chat

Seated players (and spectators, in a small strip since they have no seat
to show it on) at the same table can talk over a peer-to-peer WebRTC
connection — a mic-only or mic+camera call, signaled through the existing
Socket.IO connection but carrying audio/video directly between browsers
(the server relays only SDP offers/answers and ICE candidates, never
media). A seated player's video renders right on their own seat — see
`apps/web/src/components/Seat.tsx` and `useVoiceChat.ts`.

Two real constraints worth knowing before you rely on it:

- **Requires a secure context.** Browsers block camera/mic access on plain
  HTTP except on `localhost` — so voice/video works out of the box in
  local dev, but a LAN deployment reached over `http://192.168.x.x:5173`
  will not get camera/mic permission without HTTPS in front of it.
- **STUN only, no TURN.** ICE uses a public Google STUN server for NAT
  address discovery; there's no TURN relay. Two players both behind
  strict/symmetric NATs may fail to connect directly. Self-hosting a TURN
  server (e.g. `coturn`) and adding it to `ICE_SERVERS` in
  `useVoiceChat.ts` would close that gap if it matters for your
  deployment.

## Sign in with Google

Guests and email/password accounts work with zero configuration — Google
sign-in is an optional, additional way to make an account with one click,
not a requirement. It's entirely absent (button doesn't render, nothing
breaks) until you configure it:

1. In the [Google Cloud Console credentials page](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Under **Authorized JavaScript origins**, add every origin players will
   actually load the app from — e.g. `http://localhost:5173` for local
   dev, and your real domain (`https://poker.example.com`) in production.
   No redirect URI is needed; this uses Google's token-based Sign In With
   Google flow, not the redirect-based OAuth flow.
3. Set **both** `GOOGLE_CLIENT_ID` (server) and `VITE_GOOGLE_CLIENT_ID`
   (client build) in `.env` to that same Client ID — see `.env.example`.
4. Restart the server, and rebuild the client if you're using the Docker
   path (`VITE_GOOGLE_CLIENT_ID` is baked in at build time, since the
   client ships as a static bundle).

A guest can also link Google to their existing guest account later
("Create account" in the lobby offers it alongside email/password),
converting the same account in place — same id, same chips, same hand
history, exactly like the email/password upgrade path.

> This project's sandbox has no real Google Cloud project to test the
> actual "click the button, sign in with a real Google account" flow
> against — that inherently needs credentials only you can provide by
> following the steps above, and Google disallows automating its own
> consent screens. What IS tested for real: the server-side token
> verification and account-creation/linking logic (`apps/server/tests/googleAuth.test.ts`,
> `authService.test.ts`), and that the app degrades gracefully with zero
> Google configuration (`apps/web/tests/e2e/googleSignIn.spec.ts`). Test
> the real button yourself once you've set up a Client ID.

## How the pieces fit together

- **`packages/engine`** is the single source of truth for what's a legal
  action and what happens next. It's a pure state machine — no sockets, no
  DB, no randomness — so the server and the simulation harness both drive it
  identically, and every engine bug the 1M-hand fuzz run found is fixed at
  the root instead of papered over downstream.
- **`packages/rng`** supplies shuffles. The server derives each hand's
  shuffle from a committed server seed plus every seated player's client
  seed (see FAIRNESS.md) and feeds that into `rng`'s seeded HMAC-SHA256
  counter-mode source — the same primitive the simulation harness uses for
  its deterministic runs.
- **`packages/shared`** is the anti-cheat boundary: `projectStateForSeat`
  is the one function standing between the engine's full `TableState`
  (hole cards, undealt deck, everything) and what goes out over the wire to
  a given viewer. It's exercised by a dedicated leak test that checks every
  state transition of a full hand.
- **`apps/server`** never trusts the client for anything that matters: seat
  assignment comes from the authenticated session, not the payload; every
  action carries `handId` + `actionSeq` and is rejected if stale; legal
  actions are computed server-side and only sent to the seat whose turn it
  actually is.
- **`apps/web`** is a thin renderer over the projected state the server
  sends — it never computes legal actions or pot math itself, only displays
  what the server already decided.

## What's simplified, and why

This is a from-scratch build of a fairly large spec. Everything
correctness- and security-critical (the rules engine, server-side action
validation, anti-cheat projection, the RNG fairness scheme, the chip
ledger) got the most scrutiny and the most testing. A few things were
deliberately kept simple — each is called out at its point of use in code
comments and/or DECISIONS.md, but the shortlist is:

- **No horizontal scaling** (explicit spec exclusion): live table state
  lives in one Node process's memory. Redis is provisioned in
  `docker-compose.yml` per spec but isn't load-bearing yet — there's
  nothing today that needs cross-process coordination.
- **Run-it-twice and automated collusion-signal detection are not
  implemented.** `TableSettings.runItTwiceEnabled` exists as a setting but
  has no logic behind it yet.
- **Visual polish is functional but not exhaustive** — one card theme, no
  sound, no alternate table themes. The felt-table layout, seat/action UI,
  avatar/action-log/waitlist/voice panels, and betting controls are fully
  working and have had a real design pass (transitions, an acting-seat
  pulse, per-player avatar colors, a mobile layout); illustration-grade
  art and multiple themes were out of scope for the time available.
- **Voice/video is STUN-only** (no TURN relay) and needs a secure context
  for camera/mic access off `localhost` — see "Voice & video chat" above.
- **Google account linking only works from a guest.** A brand-new Google
  sign-in creates a fresh account, and a *guest* can link Google to
  upgrade in place. An already-registered email/password account has no
  UI path to additionally link Google — signing in with Google using that
  same email is refused (`EMAIL_TAKEN`) rather than silently creating a
  second account or silently merging into the existing one (either of
  which would be worse: a surprise duplicate account, or an unverified
  merge based on email match alone). Fixing this the right way is a
  "linked accounts" settings page, which was out of scope for the time
  available.
- **Computer players are simple, table-stakes-scale bots**, not a strong
  or adaptive AI — they're the same fixed heuristic policies the
  simulation harness uses for fuzz testing (see "Computer players"
  above), meant to be legible and fun to play against, not a serious
  single-player challenge mode.

## Fairness

See [FAIRNESS.md](./FAIRNESS.md) for the commit-reveal scheme and how a
player can independently verify any hand via `GET /fairness/:handId`.

## Rules

See [RULES.md](./RULES.md) for a summary of the NLH rules implemented, and
`packages/engine/README.md` / `packages/engine/DECISIONS.md` for the full
detail and every ambiguous-rule resolution.
