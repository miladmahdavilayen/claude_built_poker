/**
 * Seeds a real Postgres database with an admin account and a couple of
 * test player accounts. Live tables aren't seeded here — see
 * `seedDefaultTables` in `src/index.ts`, since tables only ever live in
 * the running server process's memory (no horizontal scaling; see
 * DECISIONS).
 *
 * Run with: DATABASE_URL=... pnpm db:seed
 */
import { getDb, closeDb } from './client.js';
import { DrizzleStore } from './drizzleStore.js';
import { hashPassword } from '../auth/passwords.js';

const STARTING_CHIP_GRANT = 5000;

async function ensureAccount(
  store: DrizzleStore,
  email: string,
  password: string,
  displayName: string,
  role: 'player' | 'admin',
): Promise<void> {
  const existing = await store.findUserByEmail(email);
  if (existing) {
    console.log(`  ${email} already exists, skipping.`);
    return;
  }
  const passwordHash = await hashPassword(password);
  const user = await store.createAccount(email, passwordHash, displayName);
  await store.adjustUserChips(user.id, STARTING_CHIP_GRANT);
  await store.recordLedgerEntries([
    { userId: user.id, isHouse: false, amount: STARTING_CHIP_GRANT, reason: 'admin_adjust' },
    { userId: null, isHouse: true, amount: -STARTING_CHIP_GRANT, reason: 'admin_adjust' },
  ]);
  if (role === 'admin') await store.setUserRole(user.id, 'admin');
  console.log(`  created ${role} account: ${email} / ${password}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Seeding requires a real Postgres database — start one with `docker compose up postgres` first.');
    process.exit(1);
  }

  const store = new DrizzleStore(getDb());

  console.log('Seeding accounts...');
  await ensureAccount(store, 'admin@pokerclause.local', 'admin12345', 'Admin', 'admin');
  await ensureAccount(store, 'alice@pokerclause.local', 'password123', 'Alice', 'player');
  await ensureAccount(store, 'bob@pokerclause.local', 'password123', 'Bob', 'player');

  console.log('Done.');
  await closeDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
