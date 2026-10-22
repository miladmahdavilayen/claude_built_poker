-- Deleting an account no longer forfeits its balance: what it had is kept
-- here, by normalized email and Google id, and given back when the same
-- person registers again (ledgered as 'balance_restored').
ALTER TABLE "welcome_bonus_claims" ADD COLUMN IF NOT EXISTS "carried_balance" integer;
--> statement-breakpoint
ALTER TYPE "chip_ledger_reason" ADD VALUE IF NOT EXISTS 'balance_restored';
