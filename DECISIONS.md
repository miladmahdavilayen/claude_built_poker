# Decisions (M3–M8: server, auth, client, deployment)

This continues `packages/engine/DECISIONS.md` and `packages/rng`'s own
decisions log, covering the server, client, and deployment layers built on
top of them. Each entry is a real call made during the build, with the
reasoning, so a future change can weigh it against what it's replacing
rather than re-deriving the tradeoff from scratch.

## Persistence: a `Store` interface, with in-memory and Postgres implementations

`apps/server/src/db/store.ts` defines the full persistence surface as an
interface; `memoryStore.ts` and `drizzleStore.ts` both implement it. Game
logic (`LiveTable`, `authService`, the HTTP routes) only ever depends on
the interface.

This exists because the development sandbox this was built in had no
local Postgres available (an attempt to `brew install postgresql@16` fell
back to compiling from source and was abandoned as impractically slow),
while the actual deployment path (`docker compose up`) pulls prebuilt
official Postgres/Redis images and needs no local install at all. Rather
than block all testing on that, `MemoryStore` lets the full auth + game +
persistence-call-site logic run and be unit/integration-tested without a
database, and `DrizzleStore` is the real implementation, typechecked and
schema-validated (`drizzle-kit generate` produces real Postgres DDL) but
not live-tested against an actual running Postgres instance in this
environment. **Test this path for real before trusting it in production**
— run `docker compose up`, run the migration, and confirm a hand actually
persists and round-trips through `/fairness/:handId`.

## No horizontal scaling: live tables are one process's memory

Per the project spec, horizontal scaling is explicitly out of scope.
`TableRegistry` and `LiveTable` hold all live game state in-process; there
is no cross-process locking or state sync. Redis is still provisioned in
`docker-compose.yml` (per spec) and installed as a server dependency, but
nothing in the game logic actually uses it yet — it's inert. If
horizontal scaling is ever added, this is the seam: `LiveTable`'s mutation
methods would need to move behind a per-table lock (Redis-backed or
otherwise), and broadcasts would need to go through a pub/sub layer
instead of directly calling `io.to(room).emit(...)`.

## `recordHand` takes a caller-supplied `id`

Originally each `Store` implementation generated its own hand UUID
on `recordHand` and returned it. Changed so the caller (`LiveTable`)
supplies the id upfront, because clients need to know the current hand's
id *during* the hand (embedded in `ProjectedTableState.handId`) so their
action submissions can be checked for staleness — not just after the hand
is persisted at hand-end. `Store.recordHand`'s return type changed from
`Promise<string>` to `Promise<void>` accordingly.

## Two anti-cheat/staleness gaps found and fixed during development

Both were caught by hand while building an end-to-end Socket.IO smoke
test, not by a spec checklist — worth calling out because they're exactly
the kind of bug that "looks done" (server-side validation existed) but
silently didn't work end-to-end (the client had no way to supply what the
server was validating):

1. **`actionSeq` was validated server-side but never sent to clients.**
   `LiveTable.submitAction` already rejected an action whose `actionSeq`
   didn't match `state.actionSeq` (per spec: "every inbound event carries
   `handId` and `actionSeq`; the server rejects stale, duplicate, or
   out-of-turn actions"), but `ProjectedTableState` never exposed the
   current `actionSeq` for a client to echo back. Fixed by adding
   `actionSeq: number` to `ProjectedTableState`.
2. **The fairness commitment was computed but never actually broadcast
   before the hand played out.** `commitmentFor(serverSeed)` was computed
   at hand start and correctly persisted alongside the revealed
   `serverSeed` after the hand — but nothing sent the commitment to
   clients *before* the hand, which is the entire point of a commit-reveal
   scheme (the promise has to be visible before the thing it constrains
   happens, or there's nothing to check it against). Fixed by adding
   `handCommitment: string | null` to `ProjectedTableState`, populated
   from `LiveTable`'s in-memory `currentHandRng.commitment` as soon as a
   hand starts. See FAIRNESS.md.

Both fixes follow the same shape: a `ProjectionContext` field threaded
through `projectStateForSeat`. If another "server validates X but never
tells the client what X currently is" gap turns up, that's the pattern to
reach for.

## CSRF: SameSite=Lax cookie + Origin-header check, no CSRF token

The refresh token cookie is `httpOnly; SameSite=Lax`, which is the primary
mitigation per spec — a cross-site `<form>` POST can't attach it under
Lax. On top of that, `POST /auth/*` routes reject any request whose
`Origin` header doesn't match the configured `CORS_ORIGIN` — cheap,
covers the classic cross-site-form-post vector directly, and needs no
token issuance/storage machinery. A full double-submit CSRF token was
judged unnecessary defense-in-depth for a same-site-cookie, single-origin
deployment; revisit if the deployment topology ever puts the API and
client on different sites that still need to share credentials.

## Rate limiting: in-process token buckets, not Redis-backed

`apps/server/src/socket/rateLimiter.ts` is a plain in-memory token-bucket
per socket id. Consistent with the no-horizontal-scaling decision above —
there's only one process, so there's nothing to coordinate across.
`@fastify/rate-limit` (Redis-capable) is used for HTTP routes instead,
configured to its in-memory store for the same reason.

## Default tables are seeded at server boot, not via the DB seed script

Live tables only ever exist in a running server process's memory (see
"No horizontal scaling" above), so a `db:seed` script — which writes to
Postgres — has nothing to create there; a table row written straight to
the `tables` table would have no corresponding `LiveTable` and would be
inert. Instead, `seedDefaultTables` in `apps/server/src/index.ts` creates
two public tables through `TableRegistry.createTable` on every boot
(controlled by `SEED_DEFAULT_TABLES`, default on), so a fresh self-host
isn't a blank lobby. `pnpm db:seed` (`apps/server/src/db/seed.ts`) instead
seeds real Postgres **accounts** (an admin and two test players) — the
part of a fresh deployment that *does* need to persist.

## Docker Compose and Dockerfiles are written and reviewed, not run

No Docker daemon was available in the development sandbox. The compose
file, both Dockerfiles, and `.env.example` were written carefully (each
image copies the full monorepo so pnpm's workspace lockfile resolves
cleanly; the web image bakes `VITE_API_URL` in at build time since it's a
static bundle; the server image installs a native build toolchain for
`argon2`), and reviewed line by line against the actual env vars the code
reads (`apps/server/src/index.ts`, `apps/server/src/db/client.ts`). But
this is the one part of the stack that has not been exercised by actually
running it. Treat the first `docker compose up --build` as a real test,
not a formality.

## A real Playwright E2E suite, added once WebRTC raised the stakes

An earlier version of this document noted there was no
browser-automation suite — server-side contract testing (a hand-rolled
`socket.io-client` script, then formal integration tests) was prioritized
over rendering-layer coverage, on the reasoning that the client is a thin
renderer over server-decided state. That reasoning stops holding once
client-side logic gets real complexity of its own — specifically, WebRTC
peer connection setup, which lives entirely in the browser and can't be
exercised by a server-side test at all. So `apps/web/tests/e2e/` (Playwright)
was added: five specs covering a full two-player hand with a mid-hand
hole-card-leak check, private-table invite-code enforcement, the
waitlist, session survival across a hard reload, and — using Chromium's
`--use-fake-device-for-media-stream` flag, no real camera/mic needed —
two browser contexts actually completing a WebRTC handshake and rendering
each other's video stream. Chromium was installed and run locally
(`npx playwright install chromium`) and all five specs pass against the
real dev servers; CI runs them on every PR (`.github/workflows/ci.yml`,
`e2e` job).

**Finding this bug is the entire reason this suite justified its cost:**
the first real run of the suite failed on session persistence after a
page reload — not a test bug, a real one. React StrictMode double-invokes
effects in development; `AuthContext`'s mount effect called
`/auth/refresh` unconditionally, so StrictMode fired it twice
concurrently. The refresh token is single-use and rotates on every call,
so one of the two concurrent requests always lost the race and got a 401
— and because promise resolution order isn't guaranteed, that 401 could
resolve *after* the successful one and clobber good session state back to
"logged out," non-deterministically. A server-side or manual-browser test
would very plausibly never have caught this (StrictMode-driven races are
exactly the class of bug that "looks fine when you click through it
yourself" and only shows up under real repeated automated runs). Fixed in
`AuthContext.tsx` by deduping to one shared in-flight promise
(`refreshOnce`) so both effect invocations resolve from the same single
request; see `tests/e2e/sessionRefresh.spec.ts`, kept as a permanent
regression guard.

## Private tables: invite code was generated but never actually checked

Found while writing the private-table E2E spec, and a real access-control
bug, not just a test gap: `POST /tables` generated an `inviteCode` for a
private table and returned it to the creator, and the client's "Private
table" flow built a shareable link around it — but nothing on the server
ever compared the code a joiner supplied against it. `isPrivate` only
controlled whether a table appeared in `GET /tables`'s public listing;
anyone who somehow learned a private table's UUID (e.g. by guessing, or
via a referrer leak) could join it exactly like a public one, full stop.
Fixed by threading the invite code onto `LiveTable` itself (constructor
param, from `TableRegistry.createTable`) and checking it in the
`join-table` socket handler: `isPrivate && seatId === null (not already
seated) && suppliedCode !== table.inviteCode` is rejected with
`INVALID_INVITE_CODE` before any table state is sent — a seated player
reconnecting bypasses the check, since holding a seat already proves
they were legitimately admitted once. `JoinTableSchema` gained an
optional `inviteCode` field; `apps/server/tests/socketServer.test.ts`
covers both the rejection and the admitted case against a real socket
connection (not just the `LiveTable` unit-level logic), specifically
because this class of bug lives at the wiring layer, not the game logic.

## Waitlist: visible to everyone at the table, joinable only by the unseated

`LiveTable` tracks a simple ordered waitlist (`joinWaitlist`/
`leaveWaitlist`, dedup on rejoin, auto-removed once seated), broadcast to
every viewer as part of the normal projected table state
(`ProjectedTableState.waitlist`) rather than as a separate personalized
message — since, like `seats[].playerId`, a waitlist entry isn't
anonymous (existing precedent in this codebase), every viewer can just
find their own entry by matching their own user id client-side, with no
extra per-viewer projection plumbing needed.

First version of the client panel hid the waitlist entirely for a seated
player (`{!mySeat && <WaitlistPanel/>}`), on the assumption a seated
player has nothing to do with it. The waitlist E2E spec caught this as a
real UX gap, not just a test-selector issue: a seated player has good
reason to know someone's waiting (etiquette, table-management awareness),
they just shouldn't get the join/leave *button*. Fixed by always
rendering the panel when there's anyone in the queue (or when the viewer
personally could join it), gating only the button on `!mySeat`.

## Voice/video: peer-to-peer WebRTC, signaled over the existing Socket.IO connection, full mesh

`apps/server/src/socket/socketServer.ts` gained four events —
`rtc-join`, `rtc-leave`, `rtc-signal`, plus server-driven
`rtc-peers`/`rtc-peer-joined`/`rtc-peer-left` — that do nothing but relay
opaque SDP offers/answers and ICE candidates between two sockets already
verified to be voice participants at the *same* table
(`apps/server/tests/socketServer.test.ts` covers both the relay and that
a non-participant target is silently dropped, not delivered). No media
ever touches the server. The client (`apps/web/src/useVoiceChat.ts`)
builds a full mesh: every participant connects directly to every other
participant. That's the right call at poker-table scale (≤9 seats, ≤36
connections) and the wrong one at room/broadcast scale — an SFU would be
needed there, which is explicitly out of scope for "lightweight."

Two consequences worth being upfront about (also in README.md): this is
STUN-only (a public Google STUN server for NAT address discovery, no TURN
relay), so two players both behind strict/symmetric NATs may fail to
connect directly — a production deployment wanting guaranteed
connectivity needs to add a TURN server to `ICE_SERVERS`. And
`getUserMedia` requires a secure context, which browsers define as HTTPS
or exactly `localhost` — so voice/video works in local dev out of the box
but not over a plain-HTTP LAN address, which this project's own "find
your LAN IP" self-host instructions would otherwise lead someone
straight into. Verified for real (not just typechecked) via
`tests/e2e/voice.spec.ts`, using Chromium's
`--use-fake-device-for-media-stream` flag so the test gets an actual
synthetic video track through a real peer connection with no camera/mic
hardware needed — this is what proves the `rtc-join` → `rtc-peers` →
offer/answer/ICE handshake actually completes end-to-end, not just that
the UI buttons update local state.

Mic/camera mute is implemented as `track.enabled = false/true` on the
existing local tracks (silence/black frames continue to be sent) rather
than adding/removing tracks and renegotiating — simpler, and avoids a
class of renegotiation bugs, at the cost of not supporting turning a
camera on for the first time mid-call after joining audio-only (the
camera choice is made once, at `joinCall(withVideo)`).

## Voice/video moved onto each seat, and a silent audio-only bug fixed along the way

The original voice UI put every call participant's tile in a single strip
at the top of the table, regardless of whether they were seated. Moved to
render a seated player's stream directly on their own seat
(`Seat.tsx`'s `.seat-video`), matched by `ProjectedSeat.playerId ===
VoicePeer.userId` (computed in `Table.tsx`'s `voiceStreamForSeat`) —
spectators in the call (no seat to render on) still get the old strip,
now in `VoicePanel.tsx`, alongside your own tile if *you're* unseated.

Doing this surfaced a real, separate bug in the original tile component:
it only ever rendered a `<video>` element when a stream had a video
track, so an **audio-only** remote peer's stream was never attached to
*any* playing element — no `<video>`, no `<audio>` — meaning audio-only
calls carried no sound at all. Fixed by extracting the media-attaching
logic into `StreamMedia.tsx`, which renders `<audio autoPlay>` for a
stream with no video track instead of nothing. The original E2E voice
spec only ever tested "join with video," which is exactly why it never
caught this; `voice.spec.ts`'s second case (audio-only, unseated
spectators) exercises the no-video path directly, though it currently
only asserts tile *presence*, not that audio is actually flowing — a
gap worth closing with real audio-track assertions if this keeps
mattering.

## Google sign-in: the client-side ID-token flow, not the redirect authorization-code flow

Google supports two different OAuth patterns for "sign in with Google."
The redirect/authorization-code flow (Google sends the browser to a
consent screen, then redirects back to a server-side callback URL with a
code the server exchanges for tokens) is the more traditional pattern,
but needs a registered callback URL per deployment origin, server-side
state/CSRF handling across the redirect, and a client secret. The
newer **Sign In With Google** JS library (loaded in `index.html`,
rendered by `GoogleSignInButton.tsx`) instead hands the browser a signed
ID token (a JWT) directly, in-page, no redirect — the client POSTs that
token to the server, which verifies it against Google's public keys via
`google-auth-library`'s `verifyIdToken` (`apps/server/src/auth/googleAuth.ts`)
and checks the `aud` claim matches our own Client ID, so a token minted
for some *other* app can't be replayed here.

Chosen for a self-hosted app specifically because it needs **only a
Client ID** (no client secret to keep out of the client bundle — there
isn't one to leak) and **no callback URL registration**, which matters a
lot when "deployment origin" is whatever `docker compose up` ends up
running on for a given self-hoster, not a single known production domain.
The tradeoff: this flow can't request offline/refresh access to Google's
own APIs (irrelevant here — this app only ever needs identity, once, at
sign-in) and depends on Google's own JS being loaded client-side, which
`GoogleSignInButton.tsx` treats as optional (polls for `window.google`
briefly, renders nothing if `VITE_GOOGLE_CLIENT_ID` isn't set at all).

## Google account creation/linking: fail closed on an email collision, never silently merge or duplicate

`loginOrRegisterWithGoogle` and `upgradeGuestWithGoogle`
(`authService.ts`) both check whether the Google profile's email already
belongs to a *different* existing user before creating or linking an
account, and throw `EMAIL_TAKEN` rather than proceeding. The two obvious
alternatives were both worse: silently creating a second account with the
same email (confusing — "why do I have two accounts?", and it means the
chips/history on the original account become unreachable via Google
sign-in) or silently merging into the existing account by email match
alone (a real account-takeover risk — email address alone isn't proof of
ownership of *that specific* pokerclause account, only of *a* Google
account that happens to share the string). Failing closed and telling the
person to log in with their password and link Google from there instead
is the safe default; it does mean, as things stand, only a **guest**
account has a UI path to link Google (`upgradeGuestWithGoogle`) — an
already-registered password account has no "add Google" settings flow
yet. See the README's "What's simplified" list.

## Guest play is untouched by any of this

Every Google-related addition — the button, the two new routes
(`/auth/google`, `/auth/upgrade/google`), the `google_id` column, the
GIS `<script>` tag — is strictly additive. `POST /auth/guest` and its
whole flow (`signUpGuest`, the starting chip grant, guest→email/password
upgrade) are unchanged; a fresh checkout with no `.env` at all still
boots a fully playable table via "Play as guest," and
`googleSignIn.spec.ts` asserts exactly that (guest signup + play still
works, with zero Google configuration, in the same run that proves the
button doesn't even render).

## Computer players: reuse the simulation harness's bots, don't reinvent decision logic

`packages/sim`'s bot policies (`BotPolicy.decide(view, legal, rnd)`) were
originally built for offline fuzz testing, but the shape was already
exactly what a live seat needs — a pure function from a seat-scoped view
+ legal actions + a `RandomSource` to a `PlayerAction`. Rather than write
a second, live-specific bot implementation, `packages/sim` gained a real
public entrypoint (`src/index.ts` — it never had one before; its
`package.json` already declared `exports: {".": "./src/index.ts"}` but
the file didn't exist, so `@pokerclause/sim` wasn't actually importable
as a library until now) exporting `ALL_BOT_POLICIES`, `projectSeatView`,
and the types, and `apps/server` took it on as a real dependency. A
computer player at a live table and a bot in a 1,000,000-hand fuzz run
now share the identical decision code — the same reasoning as reusing
`@pokerclause/engine` itself everywhere: one implementation to trust, not
two to keep in sync.

`LiveTable` schedules a bot's move the same way it already schedules a
human's timeout — `armClockOrBot()` checks whether the seat now on the
clock is bot-controlled and, if so, skips the human action-deadline timer
entirely and calls `scheduleBotMove` instead (a short randomized delay —
`cryptoSource()`, not `Math.random()`, which is banned repo-wide — so a
bot doesn't feel instant/robotic). `playBotTurn` re-validates that the
table hasn't moved on (hand ended some other way, the bot was removed)
before ever applying an action, since the scheduled callback fires
asynchronously and the world can change in the meantime.

`adversarial`, the bot policy specifically built to probe engine edge
cases (pinned-to-boundary raises, chained short all-ins), is excluded
from `SELECTABLE_BOT_POLICIES` — it's a QA tool, not something a casual
player would find fun to play against.

## Computer players never touch the real chip economy — same pattern as an empty seat

A bot seat gets a real `stack` in the engine's `TableState` (it needs
one to actually play), but `LiveSeat.userId` stays `null`, exactly like
an unoccupied seat. This isn't a special case — it's the *existing*
"only record ledger entries for seats with a real userId" rule in
`settleHand()` (`if (userId) ledgerEntries.push(...)`) applying
unmodified, and it's why bot seats needed zero schema changes and zero
ledger code changes. A human who wins chips off a bot gets a real,
persistent `pot_win` ledger credit sourced from the house pseudo-account,
same as any other pot; the bot's own stack just appears at buy-in time
and vanishes when the seat is cleared. Since this is play money with no
cash value (see RULES.md), a human reliably beating a weak bot to
accumulate chips isn't an economic exploit worth guarding against — if
anything it's the point of a practice/fun bot mode.

`canStartHand()` gained one more condition: at least one seat must have a
real `userId`. Without it, a table seeded with only bots (e.g. everyone
leaves but the bots stay) would deal itself hands forever with no one
watching, burning CPU for nobody's benefit.

## Two real bugs found building this, not just design decisions

**`join-table` sent an authenticated user its own state twice.** The
handler both did a direct `socket.emit('state', ...)` to the joining
socket AND called `broadcastTable(table)` (which, for an authenticated
user, already reaches that same socket via the room it just joined) —
pure duplicate traffic for every authenticated table join, invisible
until a test needed to reason precisely about "the next state event
after this action" and got the wrong one. Fixed by only doing the direct
emit for an anonymous (no `userId`) join, which changes nothing visible
to anyone else and so is never covered by `broadcastTable`.

**A bot's seat rendered as permanently empty on the client**, despite the
server broadcasting completely correct data (verified over the wire) and
`TablePage` re-rendering with the correct props (verified via direct
console output at the render site) — `Seat.tsx`'s empty-seat check was
`seat.status === 'empty' || seat.playerId === null`. `playerId` being
`null` was a reliable proxy for "unoccupied" right up until computer
players existed, which are legitimately occupied, active seats that
*always* have `playerId: null` by design (see above). Diagnosing this
took walking the data from the raw WebSocket frame, through the React
state update, through the parent component's render output, before
finding the actual JSX condition at fault — a reminder that "the network
data is correct" and "the parent component re-rendered with correct
props" don't rule out a bug in the specific child rendering logic.
Fixed by dropping the `playerId` check entirely; `status === 'empty'` is
the one authoritative signal.

## The action bar could be genuinely unreachable at a short browser viewport

Reported as "after a hand is dealt there are no options for any
actions." Reproducing this with automated clicks at Playwright's default
~720px-tall viewport showed nothing wrong — Fold/Check/Call/Bet/Raise all
appeared and worked correctly across raises and multiple hands. The bug
only showed up when the viewport was shrunk to a height more typical of
a real browser window (address bar, tabs, a bookmarks bar all eat into
the usable page height — 600–650px of actual viewport is common on a
laptop, well under Playwright's default).

`.table-page` had a hard `height: 100vh` with no overflow handling. Its
children's combined height — header, the voice panel, the waitlist panel,
the felt (`min-height: 360px`, a hard floor flexbox won't shrink below),
the action bar itself, the tab bar, and a 140px-tall chat panel — could
add up to well more than 100vh once the newer panels (voice, waitlist)
were also showing, and the overflow had nowhere to go: no scrollbar, no
sticky positioning, nothing. The buttons were legitimately rendered,
correctly, in the DOM, with entirely correct data — just below the
visible edge of the browser window with no way to reach them. This is
exactly why the earlier E2E suite never caught it: every existing spec
ran at Playwright's generous default viewport, where the bug simply
doesn't reproduce.

Fixed two ways, deliberately not relying on either alone:
1. `.table-page` gained `overflow-y: auto` — a guaranteed fallback. No
   matter how tall the content gets or how short the window is, the
   action bar is now always *reachable* by scrolling, even if it doesn't
   fit at a glance.
2. Vertical footprint was trimmed so the *common* case needs no scrolling
   at all: the felt's `min-height` dropped from 360px to 220px (160px
   under a new `@media (max-height: 700px)` block, which also shrinks the
   chat panel and voice tiles at that breakpoint).

`shortViewport.spec.ts` pins a 1280×620 viewport (chosen to be
realistic, not maximally adversarial) and asserts the action bar's
bounding box fits inside it with zero scrolling, plus that whichever
button is actually offered is clickable — a permanent regression guard
for exactly this class of bug, which is invisible at any viewport tall
enough to be a poor stand-in for a real browser window.

## The action bar disappearing "after the first action" was the same bug, worse

Reported again shortly after the fix above, described as: make one
preflop action, and the action bar never comes back for anyone. The
`overflow-y: auto` scroll fallback from the first fix was technically
correct — the buttons genuinely were reachable by scrolling — but that
fix only solved *reachability*, not *discoverability*: nothing on screen
told a real person they needed to scroll, so from their perspective it
still looked exactly like a freeze. Made worse by the fact that a
raise-capable action shows the bet-sizer (a slider, a number input, and
three preset buttons) — meaningfully taller than a bare check/call/fold
row — so the SECOND turn (the one right after "make one preflop action")
was often the first one tall enough to actually need that scroll.

Reproducing this took several attempts before landing on the right
setup: a 2-human-context test with realistic pacing worked fine; 3
all-human players worked fine; 1 human + 5 bots worked fine. None of
these matched the report. The scenario that actually mattered was the
*viewport*, not the player count or pacing — automated tests all ran at
Playwright's generous default height, exactly like the first fix's
regression test warned against.

Fixed properly this time: `.action-bar` is `position: sticky; bottom: 0`
inside `.table-page`'s own scroll area, so it's pinned to the bottom of
the visible viewport the instant it's your turn — not dependent on
scrolling, not dependent on trimming content above it to *just barely*
fit, not dependent on the viewer noticing anything. Verified down to an
extreme 420px-tall viewport with the bet-sizer showing (the tallest the
bar gets): it fits with zero scrolling, from the very first paint. The
`overflow-y: auto` fallback stays in place underneath this as a second
layer of defense, but sticky positioning is now the actual, primary fix.
`shortViewport.spec.ts` was rewritten to assert this directly (bounding
box fits at 420px height, with the bet-sizer visible) rather than the
weaker "fits at 620px" check from the first pass.

## Table position labels (UTG, HJ, CO, etc.) and verifying full-hand correctness

Added `computePositionLabels` (`apps/web/src/positionLabels.ts`), a pure
function mapping each seat currently dealt into the hand to a
conventional position name, using the same "compacted ring of occupied
seats" model the engine itself uses for button/blind assignment
(`dealtInRing` in `packages/engine/src/button.ts`) — walking seat ids in
order starting from the button — so the labels are guaranteed to agree
with wherever the real button and blinds landed, including with gaps in
seating (not every seat occupied) and after the button rotates hand to
hand.

Table-size-to-label-list is a **hand-picked lookup per size (2–9)**, not
a mechanical slice of a 9-max template. Real position naming genuinely
isn't a strict subset across sizes — 6-max conventionally uses UTG, HJ,
CO (skipping MP and UTG+1/2 entirely, not just trimming the 9-max list
down to its last 3 entries), matching the naming widely used by poker
training sites (e.g. Upswing Poker) for each size. The button seat itself
only gets the existing "D" dealer disc, not an additional redundant
"BTN" text badge next to it.

Verifying "a full hand can be played and completed flawlessly, preflop
through river" needed a **new** test, not just more runs of the existing
ones — `gameplay.spec.ts` only ever exercises check/call, which can't
catch a bug specific to the Bet/Raise buttons or the bet-sizer (exactly
what the action-bar bug above lived in). `fullHandAllStreets.spec.ts`
drives real bets on every street the human is free to act on and asserts
the board genuinely reaches the flop and the river. Building it
surfaced two more since-fixed flakiness sources worth recording:

- **`calling-station` has an intentional 5% random fold-instead-of-call**
  (by design — see `packages/sim/src/bots/callingStation.ts` — not a
  bug), which occasionally ended the test hand after a single action.
  Switched to
  `maniac`, whose own logic can only reach its fold branch when neither
  check nor call is legal — which can't happen on a genuine turn (one of
  the two is always available), making it a bot that never voluntarily
  folds.
- **An early all-in deals the remaining streets near-instantly
  server-side** (correct behavior — no further action is possible once
  both stacks are committed), which a test polling the DOM every ~100ms
  can legitimately race past without ever observing every single
  intermediate street. The test's own betting was constrained (open with
  a bet when free to act, but only ever call — never re-raise — when
  facing one) to keep pot growth bounded and make an early all-in rare,
  and the final assertion checks that the flop and the river were both
  observed rather than requiring the exact `[0,3,4,5]` sequence, so a
  legitimately-fast all-in runout doesn't fail a correct hand.

## Bot think-time: randomized 1–6s instead of a fixed sub-1.5s window

`apps/server/src/game/liveTable.ts`'s `scheduleBotMove` used to delay a
bot's action by a small, tight window (well under 1.5s). Changed to
`BOT_MOVE_MIN_MS = 1000` plus up to `BOT_MOVE_JITTER_MS = 5001` of jitter
(the `+1` is because `RandomSource.nextInt` is exclusive of its upper
bound, so this is really "up to a full 5000ms"), giving a genuine
1–6 second spread. Purely a pacing/feel change — bots acting in a
fraction of a second reads as robotic and doesn't give a human opponent
time to actually watch a hand unfold. Every test that waits out a bot's
delay (`liveTable.test.ts`'s fake-timer advances, Playwright's global
`timeout`, and `playHandToCompletion`'s round budget) was widened in
lockstep; see each file for specifics.

## Action timer: isolated into its own component, redesigned as a calm radial ring

The countdown display used to live as a `useState`/`useEffect`/
`setInterval(250ms)` hook directly inside `TablePage` itself, and
rendered as a flat, solid `var(--danger)` (red) circle for its entire
duration. Two separate problems, both visible as "the timer is funky and
flashes red across a big portion of the screen":

- Every 250ms tick re-rendered the **entire table page** — every seat,
  the board, the chat panel, everything — not just the timer, which is
  what actually produced the "funky"/janky feel under real load.
- The circle was flat red for its whole duration, not just when time was
  actually running low, so any player free to act for the full duration
  of the clock saw a persistent red alarm the entire time.

Fixed by extracting the countdown into its own `ActionTimer.tsx`, with
its own local interval state — a re-render every 200ms now only touches
this one small component, not the page tree around it. Redesigned as an
SVG radial progress ring (`stroke-dasharray`/`stroke-dashoffset`) that's
calm (`var(--good)`, green) by default and only shifts through a
`warning` and then an `urgent` (red) stage as time genuinely runs out —
never alarming for the full duration by default.

## Fair initial dealer button: a real high-card draw, not "whichever seat id is lowest"

Before this, a table's very first hand always started with the button on
whichever dealt-in seat had the lowest seat id — arbitrary, and
unfair if seat id happened to correlate with anything (e.g. join order).
Standard practice (and what this now does) is a genuine **high-card
draw**: everyone dealt in draws one card, highest card wins the button,
ties impossible on a real shuffled deck (rank first, suit as the
tiebreak in the conventional spades > hearts > diamonds > clubs order —
`SUITS` in `packages/engine` is already declared in exactly that order).

Implemented entirely in `apps/server/src/game/liveTable.ts`
(`drawInitialButtonSeat`, `dealtInRing`), with **zero engine changes**,
via a small mathematical trick: the engine's own button-rotation math
already derives the button purely from `lastBigBlindSeat` (`null` only
before a table's very first hand). Rather than special-casing "this is
the first hand, put the button HERE" somewhere in the middle of the
engine, `startNextHand` just seeds `lastBigBlindSeat` with a *computed*
value chosen so that the engine's **existing**, already-tested rotation
logic lands the button exactly on the draw's winner:

- Heads-up: button *is* the small blind, so `lastBigBlindSeat` is set
  directly to the winning seat.
- 3+-handed: the engine derives button as "one step back" from
  `lastBigBlindSeat` around the ring, so it's seeded one step *forward*
  (`nextInRing`-equivalent, re-derived locally since the engine doesn't
  export it) from the winning seat.

Covered by `apps/server/tests/liveTable.test.ts`'s
`'LiveTable: fair initial button placement'` describe block. The draw
uses real crypto randomness (not the commit-reveal fairness scheme used
for actual hand dealing — this happens before any hand or its
commitment exists) and is a private implementation detail, so the tests
are statistical/observational rather than seeded: many independent fresh
tables, asserting (a) every individual result is internally consistent
(SB/BB genuinely sit relative to wherever the button landed) and (b)
across enough trials the button lands on more than just one or two
seats. A separate test confirms the draw only ever happens once — a
second hand on the same table rotates normally instead of drawing again.

## Live pot total: a real bug in the "Pot"/"1/2 pot" bet-sizer presets

The engine only ever builds `state.pots` (with its side-pot breakdown)
once a hand fully concludes — at showdown, or when a fold ends it early
(both call sites are in `packages/engine/src/showdown.ts`; see
`buildPots`/`returnUncalledBet`). Mid-hand, `state.pots` is always `[]`.
The client's bet-sizer "1/2 pot" and "Pot" preset buttons
(`ActionBar.tsx`) computed their target amount from `state.pots`, which
means they silently resolved to 0 (clamped up to the minimum legal
bet/raise) for the entire duration of every hand, no matter how big the
real pot actually was — a real, reproducible instance of "the game isn't
giving the user the option to bet/raise to a certain amount," distinct
from manual entry (typing an amount, or the slider), which read from the
input's own local state and always worked correctly.

Fixed with `apps/web/src/potTotal.ts`'s `livePotTotal`: every seat's
`committedThisHand` (accumulated across the whole hand so far, unlike
`committedThisStreet` which resets each street) plus `anteTotal` (newly
exposed on `ProjectedTableState` — it already existed on the engine's
internal `TableState`, just wasn't in the client-facing projection)
always equals the true total in the middle, both mid-hand and after a
hand completes — the engine already adjusts `committedThisHand` for any
uncalled-bet return *before* building `pots`, so there's no need to
branch on hand phase; one formula is correct everywhere. `ActionBar`'s
`potSize` prop and `BoardAndPot`'s displayed total both switched to it.
While fixing this, also tightened the presets themselves to clamp
into `[min, max]` (they only clamped against `max` before, so a
sub-minimum preset value would display as something that wasn't what
would actually be submitted).
`betSizerPresets.spec.ts` is a dedicated regression test: two real
human pages so the preflop raise size is deterministic, then asserting
the "Pot" preset on the resulting postflop bet reads exactly the real
pot (20), not the minimum bet (2).

## Chip visuals: SB/BB/street bets rendered as real chip graphics, standard denomination color coding

Bet amounts (SB, BB, and any other street bet) used to render as plain
text (`.seat-bet`) inside a seat's own info panel — not visually
distinguishable from a stack number, and not positioned anywhere near
"in front of the player," which is how every real poker UI places a
current bet (on the felt, between the seat and the pot, swept away when
the street closes).

Added `apps/web/src/chips.ts` (a standard casino chip color ladder —
white $1, red $5, blue $10, green $25, black $100, purple $500,
yellow/orange $1000, and so on upward — plus `chipBreakdown`, a greedy
largest-denomination-first decomposition capped at a small number of
discs) and `ChipStack.tsx` (renders that breakdown as a small stack of
colored discs, each denomination-colored, with the exact amount as a
text label underneath). This is explicitly a **decorative**
representation, not a literal chip count — a real stack of e.g. 137
chips would never render as 137 discs; the color communicates rough size
at a glance and the label carries the exact truth.

Placement: `seatLayout.ts`'s `seatPositions` now also returns a
`betLeft`/`betTop` point per seat, interpolated partway between the
seat's own position and the table's center (same angle, smaller radius)
— rendered in `Table.tsx` as a sibling `.bet-chips-slot` next to each
seat, keyed to `seat.committedThisStreet` so it appears/disappears/
updates exactly in sync with each street's actual betting, with no
separate client-side state to keep in sync. The pot display
(`BoardAndPot.tsx`) got the same chip-stack treatment (amount label
suppressed there, since "Pot: N" already carries it, avoiding a
duplicate number next to the icon). `chipVisuals.spec.ts` covers SB/BB
posting the right amounts in front of the right seats — written
button-agnostic (checking whichever seat's chip amount is 1 vs 2,
not assuming seat 0 is always SB) since which seat is SB is now itself
a genuine draw (see above). Building this also exposed two *other*
existing tests that silently assumed seat 0 was always button/SB
(`shortViewport.spec.ts`, previously relying on a bot that could
fold or shove and rob the test of a deterministic turn order) — fixed by
switching that test to two real human pages with a scripted, always-call
second player, removing the randomness rather than trying to make a bot
persona behave predictably enough to trust.
