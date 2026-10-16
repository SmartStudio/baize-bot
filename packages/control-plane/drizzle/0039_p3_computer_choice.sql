ALTER TABLE "group_members" ADD COLUMN "computer_kind" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "continue_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "continues_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_continues_run_id_runs_id_fk" FOREIGN KEY ("continues_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_continues_run_idx" ON "runs" USING btree ("continues_run_id") WHERE "runs"."continues_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_computer_kind_check" CHECK ("group_members"."computer_kind" IS NULL OR "group_members"."computer_kind" IN ('local', 'remote'));