ALTER TABLE "approvals" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN "local_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "approvals_status_deadline_at_idx" ON "approvals" USING btree ("status","deadline_at");