-- Game books: one row per game at a table (see src/game/gameBook.ts),
-- rewritten after every hand while live, kept forever once final. The
-- report itself is readable YAML; the other columns are for listing and
-- lookup. Deliberately no foreign key to "tables" — a report must outlive
-- anything that might ever clean up old tables.
CREATE TABLE IF NOT EXISTS "game_reports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "table_id" uuid NOT NULL,
  "table_name" text NOT NULL,
  "status" text NOT NULL,
  "hands_played" integer NOT NULL,
  "last_hand_number" integer,
  "started_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "report_yaml" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "game_reports_table_id_updated_at_idx" ON "game_reports" ("table_id", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "game_reports_updated_at_idx" ON "game_reports" ("updated_at" DESC);
