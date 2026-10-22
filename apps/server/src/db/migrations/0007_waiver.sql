-- The friendly-game waiver every Google player agrees to before playing:
-- the version of the text they agreed to, the initials they typed, and when.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "waiver_version" integer;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "waiver_initials" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "waiver_accepted_at" timestamp with time zone;
