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
`apps/server/src/index.ts`. An owner/admin account
(`admin@pokerclause.local` / `admin12345` by default — override with
`ADMIN_EMAIL`/`ADMIN_PASSWORD`) is *also* created automatically on every
boot, regardless of storage backend — see "Owner-controlled chip
economy" below for why you need it. `docker compose exec server pnpm
db:seed` additionally seeds two real Postgres test player accounts:
`alice@pokerclause.local`, `bob@pokerclause.local` (password
`password123`).

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

Open http://localhost:5173. The front page is a single **Sign in with
Google** button (see "Sign in with Google" below for setup); every player
registers that way and plays at their own table against computer players
(see "Human player accounts"). The owner logs in through the small gear in
the bottom-right corner (`admin@pokerclause.local` / `admin12345`) and
keeps every owner control. To try the player flow locally without a Google
OAuth client, run the server with `ALLOW_TEST_SEEDING=true` and the client
with `VITE_DEV_GOOGLE_STUB=true`: the login page then shows a dev-only
stand-in that signs in as any email you type.

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
visuals for SB/BB/street bets landing in front of the right seat, the
flop/turn/river dealing animation and a bet's chip-flight animation each
genuinely appearing, the hand-winner banner/badge/loss-cue rendering
correctly for winner vs. everyone else (including the genuine split-pot
case), that no hand ever deals itself without an explicit "Play Hand"
click (not even the second hand in a row), leaving a table actually
navigating away and freeing the seat, a table auto-closing once its last
human leaves, the owner's terminate/reset controls, the whole
owner-only chip economy (a regular player has zero self-serve options;
the owner's assign-a-seat link and per-seat rebuy both work end to end),
a solo player adding a computer opponent and playing a full hand against
it with no second human involved, and — using Chromium's
fake-media-device flags, no real camera/mic needed — two seated players
actually establishing a peer-to-peer WebRTC voice/video connection and
each seeing the other's video rendered directly on their seat. See
`apps/web/tests/e2e/`.

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

Nothing deals itself: once enough players are seated (2+, at least one a
real human — computer players alone never trigger a deal), a seated
player clicks **"Play Hand"** to start it, every time, including the
next hand after one finishes. Starting a hand plays a brief shuffle
animation with a synthesized riffle sound, then deals with a card-by-card
flying animation and sound to each seat, and the same treatment carries
through the rest of the hand — the flop/turn/river each fly in as
they're dealt, a bet/call/raise sends a chip flying to the pot with a
"clink," and the hand's winner gets announced: a big animated "You Win!"
banner and a little fanfare for the winner themselves, a small quiet
badge for anyone else who won, and a brief subtle cue for a genuine
loss. All of it lightweight and asset-free (pure CSS + the Web Audio
API, no images or audio files). See
`apps/web/src/components/DealAnimation.tsx`,
`apps/web/src/components/WinCelebration.tsx`, `sound.ts`, and
DECISIONS.md.

## Owner-controlled chip economy

Buy-ins, rebuys, and adding a computer player are **owner-only** for
every table but one exception: a Google player's own practice table,
where they buy in from their own balance and add or remove bots (see
"Human player accounts" below) — never a real human invite (that stays
owner-only, full stop, and practice tables don't accept one at all). Otherwise, only the account logged in as the owner
(`role: 'admin'` — see the quickstart above) can seat/top up/add a bot
for anyone, human or bot. This isn't just a UI restriction; every one of
these is enforced server-side.

- **Seating a human**: the owner picks an empty seat and a buy-in amount
  in the **"+ Assign human"** flow, which generates a one-time invite
  link (`/table/:id?assign=:token`). Whoever opens that link is seated
  directly, with exactly that buy-in — no prompt, and their own input is
  never consulted. The link is single-use.
- **Adding a bot**: unchanged in how it looks (**"+ Add bot"**, pick a
  persona and a buy-in), just now owner-only.
- **Rebuying a player**: the owner clicks **"Rebuy"** on a specific
  seated human's own seat (not a header button anymore) and sets an
  amount — still debits that player's own chip balance, same as a
  normal buy-in, just triggered by the owner rather than requested by
  the player.
- **Terminate / Reset table**: also owner-only, in the table header.
  "Terminate" ends the table for everyone right now (refunding every
  seated human). "Reset" empties every seat and refunds every seated
  human too, but keeps the table itself — same name, settings, and URL
  — so it's ready to seat fresh right after.

The owner account is bootstrapped automatically on every server boot
(`admin@pokerclause.local` / `admin12345` by default — see the
quickstart above), regardless of storage backend, so this works out of
the box without touching Postgres.

Clicking **"Leave table"** genuinely leaves — the seat clears, its chips
are refunded to your balance, and you're sent back to the lobby. If that
leaves nobody human still seated, the table closes itself immediately
(any spectator watching gets sent to the lobby too) — a table with only
bots left in it, or nobody at all, has no reason to keep running.

## Human player accounts

Players sign in with Google — that's the only way to register. A guest is
someone the owner invited to a real table through an invite link; a guest
is never written to the database at all, not even briefly — their
account, chips, seat, and chat live only in the server process's memory
and vanish when they leave. A Google player's account and balance persist.

- **$1,000 welcome bonus, once per person.** A new Google account starts
  with $1,000 of play money. The bonus is remembered by normalized email
  (and Google account) in `welcome_bonus_claims`, which survives account
  deletion: delete the account and sign up again with the same email, and
  the new account starts at $0. A Google account needs a verified email to
  register.
- **Practice tables only.** A Google player doesn't see the lobby's
  tables. They pick 1–4 computer opponents (so at most 5 seats), one of
  three stake levels, and a buy-in from their balance, and get a private
  table of their own — no other human can join it, and no invite exists
  for it. They can swap bots in and out; nothing else. When they leave
  (or 2 minutes after their last connection drops), their chips go back to
  their balance and every record of the table is deleted — it was never
  written to the database in the first place (see DECISIONS.md).
- **Profile page** (`/profile`): what they registered with — name,
  email, Google photo, sign-in method, member-since — and a
  delete-account option (behind a type-to-confirm prompt — permanent, and
  the owner/admin account is exempt from it).
- **Admin dashboard** (`/admin`, owner-only): search every account on the
  deployment (guests never show up here — they're never persisted), view
  a player's balance and history, rename them, adjust their chips (a
  ledgered delta + reason, same double-entry accounting as every other
  chip movement), or delete their account outright. A row can be swiped
  left (or dragged, with a mouse) to reveal a per-row delete action, and
  a "Select all" checkbox plus per-row checkboxes let the owner delete
  several accounts in one bulk action.

## Computer players

Any empty seat can be filled with a computer opponent instead of waiting
for another human — useful for practice, or just playing solo for fun.
The owner clicks **"+ Add bot"** on an empty seat, picks a persona and a
buy-in, and it plays on its own, real-time, with a randomized 1–6
second "thinking" delay before each action, so it doesn't feel instant
or robotic. A table needs at least one real human seated before "Play
Hand" is even usable — a table left with only bots can never deal
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

## Playing on a phone

The felt itself is responsive and scales with how many seats a table
has (a heads-up table gets noticeably bigger seats/cards than a 9-max
one) — see `seatLayout.ts`'s `seatSizeVars()`. Two things specific to
actually playing on a phone, iPhones in particular:

- **The "⛶ Full screen" button** (bottom-left of the felt) hides this
  app's own header/voice/waitlist/chat panels, leaving just the felt
  and action bar. On desktop, Android, and iPad it also triggers the
  browser's real Fullscreen API. On an iPhone specifically it can only
  do the first part — iOS Safari doesn't support the Fullscreen API for
  an arbitrary page element at all (only a `<video>` gets that), so
  Safari's own address bar/tab UI stays put no matter what a web page
  does.
- **To actually get rid of Safari's own chrome on an iPhone**, the
  visitor adds the site to their home screen (Share → Add to Home
  Screen) and launches it from there — the `apple-mobile-web-app-
  capable` meta tag in `index.html` is what makes that launch as a
  genuine standalone window instead of a normal Safari tab. This is a
  one-time action only the visitor can take; nothing server- or
  code-side can trigger it automatically.

## Putting a real domain + HTTPS in front of a deployment

`docker-compose.yml`'s `server`/`web`/`postgres`/`redis` ports are all
bound to `127.0.0.1` on the host — reachable from the machine itself
(so `localhost:5173`/`localhost:4000` in the local quickstart above
still work exactly as written), but not from anywhere else. That's
deliberate: on any real deployment, something needs to sit in front of
this and terminate TLS anyway (voice/video and Google Sign-In both
require it — see above), so there's no reason for the raw containers
(Postgres and Redis in particular — Redis has no auth configured at
all by default) to be reachable from the internet directly.

The simplest option is [Caddy](https://caddyserver.com/), installed
directly on the host (not another container) — it gets you a real,
auto-renewing Let's Encrypt certificate with almost no config:

```
# /etc/caddy/Caddyfile
your-domain.com {
    reverse_proxy 127.0.0.1:5173
}
api.your-domain.com {
    reverse_proxy 127.0.0.1:4000
}
```

Then set `CORS_ORIGIN=https://your-domain.com` and
`VITE_API_URL=https://api.your-domain.com` in `.env` and rebuild
(`docker compose up -d --build`) — `VITE_API_URL` is baked into the
client's JS bundle at build time, so a plain restart isn't enough,
the web image has to actually rebuild. Don't have a domain yet?
[sslip.io](https://sslip.io) gives you one instantly, free, with zero
DNS setup, by encoding the IP in the hostname itself (e.g.
`1-2-3-4.sslip.io` resolves straight to `1.2.3.4`).

## Sign in with Google

Google is how players register and sign in — the front page is just the
Google button (see "Human player accounts" above). The only other ways in
are an owner's invite link (which seats a guest at a real table) and the
owner's own email/password login, reached via the small gear in the corner
of the login page. Until you configure Google, the button doesn't render
and the front page says sign-in isn't available:

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
  upgrade in place — there's no other account type a regular player could
  even have anymore (see "Human player accounts" below), so this covers
  every real case today.
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

## Production: staying up, and recovering if it doesn't

Production runs on an Oracle Cloud **Always Free** Arm server behind
Cloudflare (www.pokerclause.com). What keeps it there, and what to do if
it's ever lost:

- **Idle reclamation.** Oracle may stop an Always Free server whose CPU,
  network and memory all stay under 20% for 7 days. `oci-keepalive` (a
  lowest-priority systemd service on the server) keeps usage above that
  line, and the Oracle alarm "PokerClause IDLE RISK" emails the owner
  if memory ever sits under it for 6 hours. Upgrading the Oracle account to
  Pay As You Go (Always Free resources stay free) removes idle reclamation
  entirely and is the strongest protection.
- **Outages.** The Oracle alarm "PokerClause SERVER DOWN" fires when the
  server stops reporting; `.github/workflows/uptime.yml` checks the site
  from outside Oracle every 15 minutes and GitHub emails on failure.
- **Data.** Nightly Postgres dumps: 14 days on the server, plus an
  age-encrypted copy pushed to the private repo
  `pokerclause-backups` (60 days). The decryption key is kept only by the
  owner, never on the server. Oracle also snapshots the whole boot disk
  weekly (2 kept, plus a baseline).

**Restoring onto any fresh server** (Oracle or elsewhere):

1. Install Docker, clone this repo to `/opt/pokerclause`, restore `.env`.
2. `docker compose up -d postgres`, then decrypt the newest backup and load it:
   `age -d -i pokerclause-backup.agekey X.dump.age > X.dump` and
   `docker compose exec -T postgres pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists --no-owner < X.dump`
3. `docker compose run --rm server pnpm db:migrate && docker compose up -d`.
4. Point the Cloudflare DNS records at the new IP and update the
   `DEPLOY_HOST` secret.
