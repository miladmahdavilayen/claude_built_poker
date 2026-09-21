/**
 * Independently verifies a hand's fairness from the command line, using
 * the exact same `verifyHand` code path the `/fairness/:handId` HTTP
 * route uses — see FAIRNESS.md for what this checks and why.
 *
 * Usage: DATABASE_URL=... pnpm verify-hand <handId>
 */
import { closeDb, getDb } from '../db/client.js';
import { DrizzleStore } from '../db/drizzleStore.js';
import { verifyHand } from './commitReveal.js';

async function main(): Promise<void> {
  const handId = process.argv[2];
  if (!handId) {
    console.error('Usage: pnpm verify-hand <handId>');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const store = new DrizzleStore(getDb());
  const hand = await store.getHandForVerification(handId);
  if (!hand) {
    console.error(`Hand ${handId} not found.`);
    await closeDb();
    process.exit(1);
  }
  if (!hand.rngCommit.serverSeed || !hand.rngCommit.deckOrder) {
    console.log(`Hand ${handId}: server seed not yet revealed (commitment: ${hand.rngCommit.commitment}).`);
    await closeDb();
    return;
  }

  const result = verifyHand({
    serverSeedHex: hand.rngCommit.serverSeed,
    commitment: hand.rngCommit.commitment,
    clientSeeds: hand.rngCommit.clientSeeds,
    handNumber: hand.handNumber,
    dealtDeck: hand.rngCommit.deckOrder,
  });

  console.log(`Hand ${handId} (#${String(hand.handNumber)} at table ${hand.tableId})`);
  console.log(`  commitment matches SHA256(serverSeed): ${String(result.commitmentMatches)}`);
  console.log(`  derived deck matches dealt deck:        ${String(result.deckMatches)}`);
  console.log(`  VALID: ${String(result.valid)}`);

  await closeDb();
  process.exit(result.valid ? 0 : 2);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
