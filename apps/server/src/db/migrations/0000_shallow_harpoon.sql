CREATE TYPE "public"."chip_ledger_reason" AS ENUM('buy_in', 'cash_out', 'pot_win', 'rake', 'admin_adjust');--> statement-breakpoint
CREATE TYPE "public"."table_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('player', 'admin');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"user_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chip_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid,
	"is_house" boolean DEFAULT false NOT NULL,
	"amount" integer NOT NULL,
	"reason" "chip_ledger_reason" NOT NULL,
	"table_id" uuid,
	"hand_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hand_actions" (
	"hand_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"street" text NOT NULL,
	"seat" integer NOT NULL,
	"action" text NOT NULL,
	"amount" integer,
	"pot_after" integer NOT NULL,
	"ms_to_act" integer,
	CONSTRAINT "hand_actions_hand_id_seq_pk" PRIMARY KEY("hand_id","seq")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hand_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hand_id" uuid NOT NULL,
	"pot_index" integer NOT NULL,
	"winner_seat" integer NOT NULL,
	"amount" integer NOT NULL,
	"hand_rank_name" text,
	"best_five_cards" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hand_seats" (
	"hand_id" uuid NOT NULL,
	"seat" integer NOT NULL,
	"user_id" uuid,
	"starting_stack" integer NOT NULL,
	"hole_cards" jsonb NOT NULL,
	"net_result" integer NOT NULL,
	"showed_down" boolean DEFAULT false NOT NULL,
	CONSTRAINT "hand_seats_hand_id_seat_pk" PRIMARY KEY("hand_id","seat")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"hand_number" integer NOT NULL,
	"button_seat" integer NOT NULL,
	"board_cards" jsonb NOT NULL,
	"pot_total" integer NOT NULL,
	"rake_taken" integer DEFAULT 0 NOT NULL,
	"initial_state" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rng_commits" (
	"hand_id" uuid PRIMARY KEY NOT NULL,
	"commitment" text NOT NULL,
	"server_seed" text,
	"client_seeds" jsonb NOT NULL,
	"nonce" integer NOT NULL,
	"deck_order" jsonb,
	"revealed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" "table_status" DEFAULT 'open' NOT NULL,
	"invite_code" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"password_hash" text,
	"display_name" text NOT NULL,
	"is_guest" boolean DEFAULT true NOT NULL,
	"role" "user_role" DEFAULT 'player' NOT NULL,
	"avatar_seed" text NOT NULL,
	"client_seed" text NOT NULL,
	"chips" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chip_ledger" ADD CONSTRAINT "chip_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hand_actions" ADD CONSTRAINT "hand_actions_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hand_results" ADD CONSTRAINT "hand_results_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hand_seats" ADD CONSTRAINT "hand_seats_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hand_seats" ADD CONSTRAINT "hand_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hands" ADD CONSTRAINT "hands_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rng_commits" ADD CONSTRAINT "rng_commits_hand_id_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."hands"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tables" ADD CONSTRAINT "tables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
