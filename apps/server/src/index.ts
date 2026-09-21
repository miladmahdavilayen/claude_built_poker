import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { register } from './auth/authService.js';
import { closeDb, getDb } from './db/client.js';
import { DrizzleStore } from './db/drizzleStore.js';
import { MemoryStore } from './db/memoryStore.js';
import type { Store } from './db/store.js';
import { registerAdminRoutes } from './http/routes/admin.js';
import { registerAuthRoutes } from './http/routes/auth.js';
import { registerFairnessRoutes } from './http/routes/fairness.js';
import { registerHealthRoute } from './http/routes/health.js';
import { registerTableRoutes } from './http/routes/tables.js';
import type { TableSettings } from '@pokerclause/shared';
import type { TableRegistry } from './game/tableRegistry.js';
import { attachSocketServer } from './socket/socketServer.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Live tables only ever exist in this process's memory (see DECISIONS —
 * no horizontal scaling), so there's nothing for a DB seed script to
 * create here. Instead we spin up a couple of welcoming public tables
 * fresh on every boot, so a new self-host isn't a blank lobby.
 */
async function seedDefaultTables(registry: TableRegistry, log: FastifyBaseLogger): Promise<void> {
  const microStakes: TableSettings = {
    smallBlind: 1,
    bigBlind: 2,
    ante: 0,
    maxSeats: 6,
    straddleEnabled: false,
    minBuyIn: 40,
    maxBuyIn: 200,
    actionSeconds: 25,
    timeBankSeconds: 60,
    runItTwiceEnabled: false,
    rakePercent: 0,
    rakeCap: 0,
    noFlopNoDrop: true,
    isPrivate: false,
    disableChatInHand: false,
  };
  const highStakes: TableSettings = {
    ...microStakes,
    smallBlind: 5,
    bigBlind: 10,
    minBuyIn: 200,
    maxBuyIn: 1000,
    maxSeats: 9,
  };
  await registry.createTable('Micro Stakes 1/2', microStakes, null, null);
  await registry.createTable('High Stakes 5/10', highStakes, null, null);
  log.info('Seeded 2 default public tables.');
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
 */
async function ensureAdminAccount(store: Store, log: FastifyBaseLogger): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? 'admin@pokerclause.local';
  const password = process.env.ADMIN_PASSWORD ?? 'admin12345';
  const existing = await store.findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') await store.setUserRole(existing.id, 'admin');
    return;
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
  log.info(`Created owner/admin account: ${email} / ${password} (set ADMIN_EMAIL/ADMIN_PASSWORD to override).`);
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '0.0.0.0';
  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

  const isProd = process.env.NODE_ENV === 'production';
  const app = Fastify({
    logger: isProd
      ? { level: process.env.LOG_LEVEL ?? 'info' }
      : { level: process.env.LOG_LEVEL ?? 'info', transport: { target: 'pino-pretty' } },
  });

  await app.register(helmet, { contentSecurityPolicy: isProd });
  await app.register(cors, { origin: corsOrigin, credentials: true });
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

  let store: Store;
  if (process.env.DATABASE_URL) {
    store = new DrizzleStore(getDb());
    app.log.info('Using DrizzleStore (Postgres).');
  } else {
    store = new MemoryStore();
    app.log.warn('DATABASE_URL not set — using in-memory storage. Data will NOT persist across restarts. Set DATABASE_URL for production use.');
  }

  await ensureAdminAccount(store, app.log);

  registerHealthRoute(app);
  registerAuthRoutes(app, store);
  registerFairnessRoutes(app, store);

  const { io, registry } = attachSocketServer(app.server, { store, corsOrigin });
  registerTableRoutes(app, store, registry);
  registerAdminRoutes(app, store, registry);

  if (process.env.SEED_DEFAULT_TABLES !== 'false') {
    await seedDefaultTables(registry, app.log);
  }

  await app.listen({ port, host });
  app.log.info(`pokerclause server listening on http://${host}:${String(port)} (LAN: find your machine's local IP and use that instead of ${host})`);

  async function shutdown(signal: string): Promise<void> {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
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
