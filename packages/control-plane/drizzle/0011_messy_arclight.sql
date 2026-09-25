CREATE TABLE "account_credentials" (
	"account_id" text PRIMARY KEY NOT NULL,
	"access_enc" text NOT NULL,
	"refresh_enc" text,
	"access_expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"scope" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"computer_id" text NOT NULL,
	"platform" text NOT NULL,
	"handle" text,
	"tier" text DEFAULT 'confirm_publish' NOT NULL,
	"login" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_xhs_tier_ck" CHECK ("accounts"."platform" <> 'xiaohongshu' OR "accounts"."tier" <> 'direct_publish'),
	CONSTRAINT "accounts_handle_ck" CHECK (("accounts"."login" = 'none') = ("accounts"."handle" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "content_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"group_id" text NOT NULL,
	"bot_id" text,
	"run_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"group_id" text NOT NULL,
	"bot_id" text,
	"run_id" text,
	"plan_id" text,
	"account_id" text NOT NULL,
	"platform" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"approved_hash" text,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"edits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claimed_at" timestamp with time zone,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"action" text NOT NULL,
	"target" jsonb NOT NULL,
	"scope" text NOT NULL,
	"group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grants_owner_action_target_group_uq" UNIQUE NULLS NOT DISTINCT("owner_id","action","target","group_id"),
	CONSTRAINT "grants_scope_group_ck" CHECK (("grants"."scope" = 'project' AND "grants"."group_id" IS NOT NULL) OR ("grants"."scope" = 'forever' AND "grants"."group_id" IS NULL)),
	CONSTRAINT "grants_action_ck" CHECK ("grants"."action" NOT IN ('spend', 'account_security', 'delete')),
	CONSTRAINT "grants_forever_ck" CHECK ("grants"."scope" <> 'forever' OR "grants"."action" <> 'write_outside')
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"draft_id" text,
	"group_id" text,
	"account_id" text,
	"platform" text NOT NULL,
	"url" text NOT NULL,
	"external_id" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "publications_draft_id_unique" UNIQUE("draft_id")
);
--> statement-breakpoint
ALTER TABLE "computers" DROP CONSTRAINT "computers_owner_id_unique";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "action" text;--> statement-breakpoint
UPDATE "approvals" SET "action" = CASE "kind"
	WHEN 'send_external' THEN 'message_person'
	WHEN 'pay' THEN 'spend'
	ELSE 'external_write'
END;--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "action" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "grant_id" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "run_state" text DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "kind" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "purpose" text DEFAULT 'plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "computer_id" text;--> statement-breakpoint
UPDATE "runs" SET "computer_id" = c."id"
FROM "computers" c
WHERE c."owner_id" = "runs"."owner_id" AND c."kind" = 'local';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cadence" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_credentials" ADD CONSTRAINT "account_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plans" ADD CONSTRAINT "content_plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plans" ADD CONSTRAINT "content_plans_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plans" ADD CONSTRAINT "content_plans_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_plans" ADD CONSTRAINT "content_plans_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_plan_id_content_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."content_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_owner_id_idx" ON "accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_computer_platform_handle_idx" ON "accounts" USING btree ("computer_id","platform","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_platform_none_idx" ON "accounts" USING btree ("owner_id","platform") WHERE "accounts"."login" = 'none';--> statement-breakpoint
CREATE INDEX "content_plans_owner_id_status_idx" ON "content_plans" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "drafts_status_scheduled_at_idx" ON "drafts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "drafts_owner_id_status_idx" ON "drafts" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "drafts_plan_id_idx" ON "drafts" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "grants_owner_id_idx" ON "grants" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "publications_group_id_published_at_idx" ON "publications" USING btree ("group_id","published_at");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_owner_id_assistant_idx" ON "bots" USING btree ("owner_id") WHERE "bots"."role" = 'assistant';--> statement-breakpoint
CREATE UNIQUE INDEX "computers_owner_id_kind_idx" ON "computers" USING btree ("owner_id","kind");--> statement-breakpoint
CREATE INDEX "routines_group_id_idx" ON "routines" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "runs_computer_id_idx" ON "runs" USING btree ("computer_id");--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "kind";
