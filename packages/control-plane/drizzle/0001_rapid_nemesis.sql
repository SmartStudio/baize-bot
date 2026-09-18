CREATE TABLE "computers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"token_hash" text NOT NULL,
	"gateway_key_hash" text NOT NULL,
	"host" text,
	"idle_since" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computers_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"group_id" text NOT NULL,
	"trigger_message_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"steps" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"amount" numeric(14, 6) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_group_id_started_at_idx" ON "runs" USING btree ("group_id","started_at");--> statement-breakpoint
CREATE INDEX "runs_bot_id_idx" ON "runs" USING btree ("bot_id");