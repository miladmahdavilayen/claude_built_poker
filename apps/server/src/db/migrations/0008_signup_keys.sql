-- One-time access keys the owner generates for a new player to register
-- with. Only a SHA-256 hash of each key is stored; a key works once
-- (used_at), can expire (expires_at), be revoked (revoked_at), and can be
-- locked to one Google email (email_key, normalized).
CREATE TABLE IF NOT EXISTS "signup_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key_hash" text NOT NULL UNIQUE,
  "hint" text NOT NULL,
  "label" text NOT NULL,
  "email" text,
  "email_key" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "used_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_keys_created_at_idx" ON "signup_keys" ("created_at");
