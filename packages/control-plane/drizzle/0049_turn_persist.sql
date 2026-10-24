ALTER TABLE "groups" ADD COLUMN "turn_bot_messages" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "handoffs" ADD COLUMN "queued" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "handoffs_queued_group_id_idx" ON "handoffs" USING btree ("group_id") WHERE "handoffs"."queued";