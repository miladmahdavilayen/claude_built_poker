/**
 * Seeds a real Postgres database with the admin account and a couple of
 * test HUMAN player accounts. Live tables aren't seeded here — see
 * `seedDefaultTables` in `src/index.ts`, since tables only ever live in
 * the running server process's memory (no horizontal scaling; see
 * DECISIONS).
 *
 * The test players are seeded as Google-style accounts with a fake
 * `googleId` (no email/password) and a $0 starting balance, deliberately
 * mirroring what a real "Sign in with Google" produces now that email/
 * password self-registration no longer exists for regular players (see
 * DECISIONS.md) — only the admin account still has a password, exactly
 * as ensureAdminAccount (index.ts) creates it on every boot regardless of
 * whether this script has ever been run.
 *
 * Run with: DATABASE_URL=... pnpm db:seed
 */
import { getDb, closeDb } from './client.js';
import { DrizzleStore } from './drizzleStore.js';
import { hashPassword } from '../auth/passwords.js';

const ADMIN_STARTING_CHIP_GRANT = 5000; // mirrors authService.ts's STARTING_CHIP_GRANT for guests/admin — see ensureAdminAccount.

async function ensureAdminAccount(store: DrizzleStore, email: string, password: string, displayName: string): Promise<void> {
  const existing = await store.findUserByEmail(email);
  if (existing) {
    console.log(`  ${email} already exists, skipping.`);
    return;
  }
  const passwordHash = await hashPassword(password);
  const user = await store.createAccount(email, passwordHash, displayName);
  await store.adjustUserChips(user.id, ADMIN_STARTING_CHIP_GRANT);
  await store.recordLedgerEntries([
    { userId: user.id, isHouse: false, amount: ADMIN_STARTING_CHIP_GRANT, reason: 'admin_adjust' },
    { userId: null, isHouse: true, amount: -ADMIN_STARTING_CHIP_GRANT, reason: 'admin_adjust' },
  ]);
  await store.setUserRole(user.id, 'admin');
  console.log(`  created admin account: ${email} / ${password}`);
}

async function ensureTestPlayer(store: DrizzleStore, googleId: string, email: string, displayName: string): Promise<void> {
  const existing = await store.findUserByGoogleId(googleId);
  if (existing) {
    console.log(`  ${displayName} already exists, skipping.`);
    return;
  }
  await store.createGoogleAccount(googleId, email, displayName);
  console.log(`  created test player: ${displayName} (0 chips — sign in as them and have the admin grant a buy-in from the dashboard)`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Seeding requires a real Postgres database — start one with `docker compose up postgres` first.');
    process.exit(1);
  }

  const store = new DrizzleStore(getDb());

  console.log('Seeding accounts...');
  await ensureAdminAccount(store, 'admin@pokerclause.local', 'admin12345', 'Admin');
  await ensureTestPlayer(store, 'seed-test-alice', 'alice@pokerclause.local', 'Alice');
  await ensureTestPlayer(store, 'seed-test-bob', 'bob@pokerclause.local', 'Bob');

  console.log('Done.');
  await closeDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
