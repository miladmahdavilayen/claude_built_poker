-- Every signed copy of the friendly-game waiver, kept forever: the PDF as
-- signed, the drawn signature, and the authorization record (who, when,
-- IP, device, the PDF's SHA-256). No foreign key to users on purpose — a
-- deleted account's signed waiver stays with the owner.
CREATE TABLE IF NOT EXISTS "signed_waivers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text,
  "display_name" text NOT NULL,
  "email" text,
  "google_id" text,
  "version" integer NOT NULL,
  "initials" text NOT NULL,
  "signed_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "signature_png" text NOT NULL,
  "pdf" text NOT NULL,
  "pdf_sha256" text NOT NULL,
  "record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signed_waivers_signed_at_idx" ON "signed_waivers" ("signed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signed_waivers_user_id_idx" ON "signed_waivers" ("user_id");
