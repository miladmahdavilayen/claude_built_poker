-- Google sign-in becomes the way in for every player: their Google profile
-- photo and last sign-in are kept on the account, and every welcome bonus
-- ever granted is remembered by normalized email (and Google id) in a table
-- with no foreign key to users, so it survives the account being deleted
-- and a re-registration never earns a second bonus.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "welcome_bonus_claims" (
  "email_key" text PRIMARY KEY NOT NULL,
  "google_id" text UNIQUE,
  "amount" integer NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TYPE "chip_ledger_reason" ADD VALUE IF NOT EXISTS 'welcome_bonus';
