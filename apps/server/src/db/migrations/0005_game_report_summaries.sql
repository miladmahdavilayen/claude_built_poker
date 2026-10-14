-- Game reports become browsable without parsing YAML: headline numbers
-- (all cents) as columns on game_reports, and each game's standings as
-- rows in game_report_players (rewritten with the report after every
-- hand). Reports saved before this migration get these filled in from
-- their YAML on the next server boot (backfillGameReportSummaries).
ALTER TABLE "game_reports" ADD COLUMN IF NOT EXISTS "game_number" integer;
--> statement-breakpoint
ALTER TABLE "game_reports" ADD COLUMN IF NOT EXISTS "stakes" text;
--> statement-breakpoint
ALTER TABLE "game_reports" ADD COLUMN IF NOT EXISTS "player_count" integer;
--> statement-breakpoint
ALTER TABLE "game_reports" ADD COLUMN IF NOT EXISTS "total_bought_in" bigint;
--> statement-breakpoint
ALTER TABLE "game_reports" ADD COLUMN IF NOT EXISTS "total_cashed_out" bigint;
--> statement-breakpoint
ALTER TABLE "game_reports" ADD COLUMN IF NOT EXISTS "still_on_table" bigint;
--> statement-breakpoint
ALTER TABLE "game_reports" ADD COLUMN IF NOT EXISTS "books_balance" boolean;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "game_reports_started_at_idx" ON "game_reports" ("started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "game_reports_table_name_started_at_idx" ON "game_reports" ("table_name", "started_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "game_report_players" (
  "report_id" uuid NOT NULL REFERENCES "game_reports"("id") ON DELETE CASCADE,
  "rank" integer NOT NULL,
  "player_name" text NOT NULL,
  "user_id" text,
  "player_type" text NOT NULL,
  "bought_in" bigint NOT NULL,
  "buy_in_count" integer NOT NULL,
  "cashed_out" bigint NOT NULL,
  "on_table" bigint NOT NULL,
  "net" bigint NOT NULL,
  "hands_played" integer NOT NULL,
  "hands_won" integer NOT NULL,
  PRIMARY KEY ("report_id", "rank")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "game_report_players_user_id_idx" ON "game_report_players" ("user_id");
