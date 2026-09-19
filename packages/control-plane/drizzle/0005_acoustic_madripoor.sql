CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "skill_offer_source" text;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_bot_id_name_idx" ON "skills" USING btree ("bot_id","name");