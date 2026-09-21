import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from './client.js';

async function main(): Promise<void> {
  const db = getDb();
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  process.stdout.write('Migrations applied.\n');
  await closeDb();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
