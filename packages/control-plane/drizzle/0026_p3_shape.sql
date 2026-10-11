CREATE TABLE "poker_events" (
	"hand_id" text NOT NULL,
	"seq" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poker_events_hand_id_seq_pk" PRIMARY KEY("hand_id","seq")
);
--> statement-breakpoint
CREATE TABLE "poker_hands" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"session_id" text NOT NULL,
	"number" integer NOT NULL,
	"seed" text NOT NULL,
	"seats_start" jsonb NOT NULL,
	"button_seat" integer NOT NULL,
	"blinds" jsonb NOT NULL,
	"status" text DEFAULT 'playing' NOT NULL,
	"turn_seat" integer,
	"turn_run_id" text,
	"turn_attempts" integer DEFAULT 0 NOT NULL,
	"turn_deadline" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "poker_hands_status_check" CHECK ("poker_hands"."status" IN ('playing', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "poker_hints" (
	"hand_id" text NOT NULL,
	"seq" integer NOT NULL,
	"run_id" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poker_hints_hand_id_seq_pk" PRIMARY KEY("hand_id","seq")
);
--> statement-breakpoint
CREATE TABLE "poker_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"review" jsonb
);
--> statement-breakpoint
CREATE TABLE "poker_tables" (
	"group_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"request_id" text NOT NULL,
	"seats" jsonb NOT NULL,
	"button_seat" integer NOT NULL,
	"small_blind" integer NOT NULL,
	"big_blind" integer NOT NULL,
	"starting_stack" integer NOT NULL,
	"hand_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poker_tables_status_check" CHECK ("poker_tables"."status" IN ('idle', 'in_hand'))
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "preset" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "visible_to" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "visible_to" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "table_role" text;--> statement-breakpoint
ALTER TABLE "poker_events" ADD CONSTRAINT "poker_events_hand_id_poker_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."poker_hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_group_id_poker_tables_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."poker_tables"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_session_id_poker_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."poker_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_turn_run_id_runs_id_fk" FOREIGN KEY ("turn_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hints" ADD CONSTRAINT "poker_hints_hand_id_poker_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."poker_hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hints" ADD CONSTRAINT "poker_hints_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hints" ADD CONSTRAINT "poker_hints_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_sessions" ADD CONSTRAINT "poker_sessions_group_id_poker_tables_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."poker_tables"("group_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "poker_hands_group_id_number_idx" ON "poker_hands" USING btree ("group_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "poker_hands_group_id_playing_idx" ON "poker_hands" USING btree ("group_id") WHERE "poker_hands"."status" = 'playing';--> statement-breakpoint
CREATE INDEX "poker_hands_session_id_idx" ON "poker_hands" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "poker_sessions_group_id_idx" ON "poker_sessions" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poker_sessions_group_id_open_idx" ON "poker_sessions" USING btree ("group_id") WHERE "poker_sessions"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "poker_tables_owner_id_request_id_idx" ON "poker_tables" USING btree ("owner_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bots_owner_id_preset_idx" ON "bots" USING btree ("owner_id","preset") WHERE "bots"."preset" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_table_role_open_idx" ON "runs" USING btree ("group_id","table_role") WHERE "runs"."table_role" IN ('advisor', 'reviewer') AND "runs"."ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_table_bot_open_idx" ON "runs" USING btree ("bot_id","group_id") WHERE "runs"."table_role" IS NOT NULL AND "runs"."ended_at" IS NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_visible_to_check" CHECK ("messages"."visible_to" IS NULL OR (jsonb_typeof("messages"."visible_to") = 'array' AND jsonb_array_length("messages"."visible_to") > 0));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_table_role_check" CHECK ("runs"."table_role" IS NULL OR "runs"."table_role" IN ('player', 'advisor', 'reviewer'));