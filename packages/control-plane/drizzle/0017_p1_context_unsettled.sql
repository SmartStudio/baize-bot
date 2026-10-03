ALTER TABLE "runs" ADD COLUMN "unsettled_context" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "context_confirmed_at" timestamp with time zone;