-- Server-wide facts that must survive restarts — first: that the default
-- tables were created once, so a table the owner deletes stays deleted
-- instead of being re-created on the next boot.
CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
