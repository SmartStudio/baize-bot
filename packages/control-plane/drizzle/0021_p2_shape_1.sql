CREATE TABLE "bot_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"text" text NOT NULL,
	"source_message_id" text,
	"private" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_books" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"facts" text DEFAULT '' NOT NULL,
	"voice" text DEFAULT '' NOT NULL,
	"taboo" text DEFAULT '' NOT NULL,
	"assets_dir" text,
	"edits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"value" numeric NOT NULL,
	"source" text NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"run_id" text,
	"week_start" date NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "state" text DEFAULT 'on' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "boundary" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "on_today" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_target" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_unit" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "metric_source" jsonb;--> statement-breakpoint
ALTER TABLE "bot_preferences" ADD CONSTRAINT "bot_preferences_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_preferences" ADD CONSTRAINT "bot_preferences_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_books" ADD CONSTRAINT "brand_books_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reviews" ADD CONSTRAINT "project_reviews_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_reviews" ADD CONSTRAINT "project_reviews_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_preferences_bot_id_idx" ON "bot_preferences" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "metric_samples_group_id_sampled_at_idx" ON "metric_samples" USING btree ("group_id","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_reviews_group_id_week_start_idx" ON "project_reviews" USING btree ("group_id","week_start");--> statement-breakpoint
UPDATE "bots" SET "tags" = ARRAY["tag"] WHERE "tag" <> '';--> statement-breakpoint
UPDATE "messages" SET "body" = jsonb_set("body", '{team}', COALESCE((
	SELECT jsonb_agg(
		(member - 'tag') || jsonb_build_object('tags', CASE
			WHEN jsonb_typeof(member->'tags') = 'array' THEN
				CASE WHEN COALESCE(member->>'tag', '') <> ''
					AND NOT ((member->'tags') @> jsonb_build_array(member->>'tag'))
					AND jsonb_array_length(member->'tags') < 5
				THEN jsonb_build_array(member->>'tag') || (member->'tags')
				ELSE member->'tags' END
			WHEN COALESCE(member->>'tag', '') = '' THEN '[]'::jsonb
			ELSE jsonb_build_array(member->>'tag') END)
		ORDER BY position
	)
	FROM jsonb_array_elements("body"->'team') WITH ORDINALITY AS team(member, position)
), '[]'::jsonb))
WHERE "body"->>'kind' = 'project_offer' AND jsonb_typeof("body"->'team') = 'array';--> statement-breakpoint
UPDATE "routines" SET "state" = CASE WHEN "enabled" THEN 'on' ELSE 'paused' END;--> statement-breakpoint
ALTER TABLE "bots" DROP COLUMN "tag";--> statement-breakpoint
ALTER TABLE "routines" DROP COLUMN "enabled";