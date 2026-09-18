CREATE TABLE "handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"from_bot_id" text NOT NULL,
	"to_bot_id" text NOT NULL,
	"done" text NOT NULL,
	"not_done" text NOT NULL,
	"next" text NOT NULL,
	"checklist_index" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"reminded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_from_bot_id_bots_id_fk" FOREIGN KEY ("from_bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_bot_id_bots_id_fk" FOREIGN KEY ("to_bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoffs_group_id_status_idx" ON "handoffs" USING btree ("group_id","status");