-- An owner's seat invite links, kept for as long as the table is open: a
-- guest can always come back by the same link — after leaving the table,
-- on another device, or after the server restarts. Only each token's
-- SHA-256 is stored; once used, the invite belongs to the guest who used it.
CREATE TABLE IF NOT EXISTS "seat_invites" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "table_id" text NOT NULL,
  "seat_id" integer NOT NULL,
  "buy_in" integer NOT NULL,
  "owner_nickname" text,
  "guest_user_id" text,
  "created_at" timestamp with time zone NOT NULL,
  "redeemed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seat_invites_table_id_idx" ON "seat_invites" ("table_id");
