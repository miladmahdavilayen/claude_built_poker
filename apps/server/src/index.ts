import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { register } from './auth/authService.js';
import { hashPassword } from './auth/passwords.js';
import { closeDb, getDb } from './db/client.js';
import { DrizzleStore } from './db/drizzleStore.js';
import { HybridStore } from './db/hybridStore.js';
import { MemoryStore } from './db/memoryStore.js';
import type { Store } from './db/store.js';
import { registerAdminRoutes } from './http/routes/admin.js';
import { registerReportRoutes } from './http/routes/reports.js';
import { registerAuthRoutes } from './http/routes/auth.js';
import { registerFairnessRoutes } from './http/routes/fairness.js';
import { registerHealthRoute } from './http/routes/health.js';
import { registerTableRoutes } from './http/routes/tables.js';
import { registerTestSeedRoutes } from './http/routes/testSeed.js';
import { registerUserRoutes } from './http/routes/users.js';
import type { TableSettings } from '@pokerclause/shared';
import type { TableRegistry } from './game/tableRegistry.js';
import { attachSocketServer } from './socket/socketServer.js';
import { backfillGameReportSummaries, finishInterruptedGameReports } from './reports/backfill.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The welcoming public tables a new deployment starts with, so it isn't a
 * blank lobby — created on the very first boot only (see openTables);
 * after that they're ordinary tables the owner can delete.
 */
async function seedDefaultTables(registry: TableRegistry, log: FastifyBaseLogger): Promise<void> {
  // All amounts in cents (see packages/shared/src/money.ts). Buy-ins run
  // 40–100 big blinds at every stake.
  const lowStakes: TableSettings = {
    smallBlind: 100, // $1/$2, $80–$200 buy-in
    bigBlind: 200,
    ante: 0,
    maxSeats: 9,
    straddleEnabled: false,
    minBuyIn: 8_000,
    maxBuyIn: 20_000,
    actionSeconds: 25,
    timeBankSeconds: 60,
    runItTwiceEnabled: false,
    rakePercent: 0,
    rakeCap: 0,
    noFlopNoDrop: true,
    isPrivate: false,
    disableChatInHand: false,
  };
  // $10/$20, $800–$2,000 buy-in
  const mediumStakes: TableSettings = { ...lowStakes, smallBlind: 1_000, bigBlind: 2_000, minBuyIn: 80_000, maxBuyIn: 200_000 };
  // $100/$200, $8,000–$20,000 buy-in
  const highStakes: TableSettings = { ...lowStakes, smallBlind: 10_000, bigBlind: 20_000, minBuyIn: 800_000, maxBuyIn: 2_000_000 };
  // Same stakes, two seats only.
  const headsUpHighStakes: TableSettings = { ...highStakes, maxSeats: 2 };
  // Lobby lists tables in creation order, so this one shows first.
  await registry.createTable('Heads Up High Stakes $100/$200', headsUpHighStakes, null, null);
  await registry.createTable('High Stakes $100/$200', highStakes, null, null);
  await registry.createTable('Medium Stakes $10/$20', mediumStakes, null, null);
  await registry.createTable('Low Stakes $1/$2', lowStakes, null, null);
  log.info('Seeded 4 default public tables (heads-up high, high, medium, low stakes).');
}

/**
 * Puts the lobby back the way it was. The very first boot creates the
 * default tables (and records that it did); every boot after restores
 * whichever tables were open when the server last stopped — so a table the
 * owner deleted stays deleted, and tables the owner created survive a
 * deploy. Before this, every boot created the four defaults afresh, and a
 * deleted default table came back on the next deploy.
 *
 * The first boot also closes any table left marked open from before this
 * existed (a crash, an old server), so they don't all come back at once.
 */
async function openTables(store: Store, registry: TableRegistry, log: FastifyBaseLogger): Promise<void> {
  const SEEDED = 'default_tables_seeded';
  if (await store.getSetting(SEEDED)) {
    const open = await store.listTables();
    // Each with its seat invites, so a guest's link still brings them back.
    for (const record of open) registry.restore(record).loadSeatInvites(await store.listSeatInvites(record.id));
    log.info(`Restored ${String(open.length)} open table(s).`);
    return;
  }
  for (const stale of await store.listTables()) await store.closeTable(stale.id);
  if (process.env.SEED_DEFAULT_TABLES !== 'false') await seedDefaultTables(registry, log);
  await store.setSetting(SEEDED, new Date().toISOString());
}

/**
 * `db/seed.ts` also creates an admin account, but it requires a real
 * Postgres `DATABASE_URL` and is a manual, one-off script — it never
 * runs for the (default, no-`DATABASE_URL`) in-memory store, which meant
 * there was no way at all for the person self-hosting this app to reach
 * owner-only controls (terminate/reset a table, assign chips) without
 * first standing up Postgres by hand. This runs unconditionally, on
 * every boot, against whichever store is active — a no-op past the
 * first boot for a persistent store, and necessarily re-created every
 * time for the in-memory store (nothing survives a restart there
 * anyway). Credentials are configurable via env vars so a real
 * deployment isn't stuck with a published default password.
 *
 * The password is re-synced to ADMIN_PASSWORD on EVERY boot too, not
 * just checked at creation — there's no "change my password" UI for a
 * real account anywhere in this app, so ADMIN_PASSWORD is the only way
 * to rotate the owner's password at all. An earlier version only ever
 * set it once at creation, silently leaving an old password in place
 * forever after — changing the env var and redeploying looked like it
 * should rotate the password but did nothing. See DECISIONS.md.
 */
async function ensureAdminAccount(store: Store, log: FastifyBaseLogger): Promise<string> {
  const email = process.env.ADMIN_EMAIL ?? 'admin@pokerclause.local';
  const password = process.env.ADMIN_PASSWORD ?? 'admin12345';
  const existing = await store.findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') await store.setUserRole(existing.id, 'admin');
    await store.updatePasswordHash(existing.id, await hashPassword(password));
    return existing.id;
  }
  // Reuses the real registration path (not a hand-rolled duplicate of
  // it) specifically so the owner account gets the same starting chip
  // grant every other account gets — an earlier version of this created
  // the account directly via store.createAccount, which skipped that
  // grant entirely and left a fresh owner unable to even seat themselves
  // (INSUFFICIENT_CHIPS) until they used the admin HTTP route to grant
  // their own account chips first. See DECISIONS.md.
  const result = await register(store, email, password, 'Owner');
  await store.setUserRole(result.user.id, 'admin');
  // A test server can start the owner with a set balance (ADMIN_START_BALANCE, in dollars) instead of the
  // usual grant — local testing with $1,000,000 to seat themselves and fund invites. Never set in production.
  const startDollars = Number(process.env.ADMIN_START_BALANCE);
  if (Number.isFinite(startDollars) && startDollars > 0) {
    await store.adjustUserChips(result.user.id, Math.round(startDollars * 100) - result.user.chips);
  }
  log.info(`Created owner/admin account: ${email} / ${password} (set ADMIN_EMAIL/ADMIN_PASSWORD to override).`);
  return result.user.id;
}

/**
 * Behind a reverse proxy (Caddy, itself behind Cloudflare in production)
 * every request reaches Fastify from the proxy's address, so without this
 * `req.ip` — the key every per-IP rate limit uses — is the same for all
 * visitors, and one abuser exhausts the limit for everyone. Unset (local
 * dev, tests) means "trust nothing", Fastify's default. Otherwise it's
 * the proxy addresses to trust, e.g. `loopback,uniquelocal` for a proxy on
 * the same host reaching the container over Docker's bridge network.
 */
function parseTrustProxy(raw: string): boolean | string {
  return raw === 'true' ? true : raw;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '0.0.0.0';
  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

  const isProd = process.env.NODE_ENV === 'production';
  const app = Fastify({
    // Nothing this API accepts comes close (the biggest is a 200-id bulk
    // delete); Fastify's 1 MB default just gives a flood more to chew on.
    bodyLimit: 64 * 1024,
    ...(process.env.TRUST_PROXY ? { trustProxy: parseTrustProxy(process.env.TRUST_PROXY) } : {}),
    logger: isProd
      ? { level: process.env.LOG_LEVEL ?? 'info' }
      : { level: process.env.LOG_LEVEL ?? 'info', transport: { target: 'pino-pretty' } },
  });

  await app.register(helmet, { contentSecurityPolicy: isProd });
  // Content-Disposition is exposed so the browser can read a report download's filename (table, hand number and time).
  await app.register(cors, { origin: corsOrigin, credentials: true, exposedHeaders: ['Content-Disposition'] });
  await app.register(cookie);
  // Configurable so the E2E suite (many short-lived tests sharing ONE
  // server process across the whole run — see playwright.config.ts) can
  // raise it well above what a real client would ever need, instead of
  // production's HTTP-abuse-appropriate limit becoming test flakiness as
  // the suite grows. See DECISIONS.md.
  await app.register(rateLimit, { max: Number(process.env.RATE_LIMIT_MAX ?? 100), timeWindow: '1 minute' });

  // CSRF defense-in-depth on state-changing auth routes: SameSite=Lax on
  // the refresh cookie is the primary mitigation (per spec); this Origin
  // check is a second layer that costs nothing and blocks the classic
  // cross-site form-post CSRF vector outright.
  app.addHook('preHandler', (req, reply, done) => {
    if (req.method === 'POST' && req.url.startsWith('/auth/')) {
      const origin = req.headers.origin;
      if (origin && origin !== corsOrigin) {
        void reply.code(403).send({ code: 'BAD_ORIGIN', message: 'Cross-origin request rejected.' });
        return;
      }
    }
    done();
  });

  let persistentStore: Store;
  if (process.env.DATABASE_URL) {
    persistentStore = new DrizzleStore(getDb());
    app.log.info('Using DrizzleStore (Postgres).');
  } else {
    persistentStore = new MemoryStore();
    app.log.warn('DATABASE_URL not set — using in-memory storage. Data will NOT persist across restarts. Set DATABASE_URL for production use.');
  }
  // Wraps whichever backend above with the guest boundary: a guest's user
  // row, session, and any ledger/hand/chat rows they're party to never
  // reach it — only a signed-in (Google) account is ever persisted. See
  // HybridStore's own doc comment and DECISIONS.md.
  const store: Store = new HybridStore(persistentStore);

  const adminUserId = await ensureAdminAccount(store, app.log);

  registerHealthRoute(app);
  registerFairnessRoutes(app, store);
  registerTestSeedRoutes(app, store);

  const { io, registry, closeAllTables, terminateTable, updateTableSettings, closePracticeTableOf, watchPracticeTable } = attachSocketServer(app.server, { store, corsOrigin, adminUserId });
  registerAuthRoutes(app, store, (token) => registry.describeInvite(token));
  registerUserRoutes(app, store, closePracticeTableOf);
  registerTableRoutes(app, store, registry, watchPracticeTable);
  registerAdminRoutes(app, store, registry, closePracticeTableOf, terminateTable, updateTableSettings);
  registerReportRoutes(app, store, registry);

  await finishInterruptedGameReports(store, (msg) => app.log.info(msg));
  await backfillGameReportSummaries(store, (msg) => app.log.info(msg));

  await openTables(store, registry, app.log);

  await app.listen({ port, host });
  app.log.info(`pokerclause server listening on http://${host}:${String(port)} (LAN: find your machine's local IP and use that instead of ${host})`);

  async function shutdown(signal: string): Promise<void> {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await closeAllTables();
    } catch (err) {
      app.log.error(err, 'Failed to close every table cleanly on shutdown');
    }
    await io.close();
    await app.close();
    if (process.env.DATABASE_URL) await closeDb();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
