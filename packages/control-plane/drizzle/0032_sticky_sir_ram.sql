CREATE TABLE "lane_leases" (
	"bot_id" text NOT NULL,
	"group_id" text NOT NULL,
	"holder_computer_id" text NOT NULL,
	"holder_install_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lane_leases_bot_id_group_id_pk" PRIMARY KEY("bot_id","group_id"),
	CONSTRAINT "lane_leases_epoch_check" CHECK ("lane_leases"."epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_entries" (
	"bot_id" text NOT NULL,
	"group_id" text NOT NULL,
	"stream" text NOT NULL,
	"seq" integer NOT NULL,
	"epoch" integer NOT NULL,
	"owner_id" text NOT NULL,
	"run_id" text,
	"entry_id" text NOT NULL,
	"parent_id" text,
	"pi_type" text NOT NULL,
	"retention" text NOT NULL,
	"line" text NOT NULL,
	"search_text" text NOT NULL,
	"visible_to" jsonb,
	CONSTRAINT "work_entries_bot_id_group_id_stream_seq_pk" PRIMARY KEY("bot_id","group_id","stream","seq"),
	CONSTRAINT "work_entries_stream_check" CHECK ("work_entries"."stream" IN ('chat', 'table')),
	CONSTRAINT "work_entries_retention_check" CHECK ("work_entries"."retention" IN ('verbatim', 'redacted')),
	CONSTRAINT "work_entries_seq_check" CHECK ("work_entries"."seq" >= 0),
	CONSTRAINT "work_entries_visible_to_check" CHECK ("work_entries"."visible_to" IS NULL OR (jsonb_typeof("work_entries"."visible_to") = 'array' AND jsonb_array_length("work_entries"."visible_to") > 0))
);
--> statement-breakpoint
CREATE TABLE "work_streams" (
	"bot_id" text NOT NULL,
	"group_id" text NOT NULL,
	"stream" text NOT NULL,
	"next_seq" integer DEFAULT 0 NOT NULL,
	"head" text DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
	"tail_entry_id" text,
	"pi_session_version" integer NOT NULL,
	CONSTRAINT "work_streams_bot_id_group_id_stream_pk" PRIMARY KEY("bot_id","group_id","stream"),
	CONSTRAINT "work_streams_stream_check" CHECK ("work_streams"."stream" IN ('chat', 'table')),
	CONSTRAINT "work_streams_next_seq_check" CHECK ("work_streams"."next_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "install_id" text;--> statement-breakpoint
ALTER TABLE "lane_leases" ADD CONSTRAINT "lane_leases_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_leases" ADD CONSTRAINT "lane_leases_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_leases" ADD CONSTRAINT "lane_leases_holder_computer_id_computers_id_fk" FOREIGN KEY ("holder_computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_entries" ADD CONSTRAINT "work_entries_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_entries" ADD CONSTRAINT "work_entries_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_entries" ADD CONSTRAINT "work_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_entries" ADD CONSTRAINT "work_entries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;