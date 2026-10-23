-- The chips each guest left each table with: a guest who leaves (or loses
-- their session, or the server restarts) sits back down with them when they
-- come back by the same link — the table's starting chips only go to a new
-- player.
CREATE TABLE IF NOT EXISTS "guest_stacks" (
  "guest_id" text NOT NULL,
  "table_id" text NOT NULL,
  "chips" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "guest_stacks_guest_id_table_id_pk" PRIMARY KEY ("guest_id", "table_id")
);
--> statement-breakpoint
-- An open-invite guest's browser keeps a random secret for the link; its
-- SHA-256 here is how the same guest is recognised when they come back.
ALTER TABLE "guest_players" ADD COLUMN IF NOT EXISTS "guest_key_hash" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_players_table_key_idx" ON "guest_players" ("table_id", "guest_key_hash");
