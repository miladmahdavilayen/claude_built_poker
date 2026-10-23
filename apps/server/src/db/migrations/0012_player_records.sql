-- Every guest who joins a table by an owner's invite (a one-person seat
-- invite, or an open-invite table's link) is now kept on record: who they
-- said they were, the name the owner gave the invite (seat invites), which
-- table, and their acceptance of the guest terms — when, from which IP
-- address, on what device. The guest's session itself still lives only in
-- the server's memory; this is the permanent record of them.
CREATE TABLE IF NOT EXISTS "guest_players" (
  "id" uuid PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "admin_nickname" text,
  "invite_kind" text NOT NULL,
  "table_id" text,
  "table_name" text,
  "joined_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "terms_version" integer NOT NULL,
  "terms_accepted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_players_joined_at_idx" ON "guest_players" ("joined_at");
--> statement-breakpoint
-- A registered player's account as it was when it was deleted — kept for
-- the owner only (the person can register again normally; this never
-- blocks it). Their signed waivers and game history stay in their own
-- tables, found by user_id; the ledger history is copied here because its
-- rows lose their user_id when the account goes.
CREATE TABLE IF NOT EXISTS "deleted_users" (
  "id" uuid PRIMARY KEY NOT NULL,
  "email" text,
  "google_id" text,
  "display_name" text NOT NULL,
  "access_key_label" text,
  "role" text NOT NULL,
  "balance" integer NOT NULL,
  "net_play_result" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "last_login_at" timestamp with time zone,
  "deleted_at" timestamp with time zone NOT NULL,
  "deleted_by" text NOT NULL,
  "snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deleted_users_deleted_at_idx" ON "deleted_users" ("deleted_at");
--> statement-breakpoint
-- The name the owner gave the access key a player registered with — kept on
-- the player's own account, so the owner always knows who they are.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "access_key_label" text;
--> statement-breakpoint
UPDATE "users" u SET "access_key_label" = k."label" FROM "signup_keys" k WHERE k."used_by" = u."id" AND u."access_key_label" IS NULL;
--> statement-breakpoint
-- A used key stays linked to the account it registered even after that
-- account is deleted (it's shown under the deleted account then).
ALTER TABLE "signup_keys" DROP CONSTRAINT IF EXISTS "signup_keys_used_by_fkey";
