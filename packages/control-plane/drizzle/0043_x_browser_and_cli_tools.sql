CREATE TABLE "cli_tool_bots" (
	"tool_id" text NOT NULL,
	"bot_id" text NOT NULL,
	CONSTRAINT "cli_tool_bots_tool_id_bot_id_pk" PRIMARY KEY("tool_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "cli_tool_env" (
	"tool_id" text NOT NULL,
	"name" text NOT NULL,
	"value_enc" text NOT NULL,
	"last4" text NOT NULL,
	CONSTRAINT "cli_tool_env_tool_id_name_pk" PRIMARY KEY("tool_id","name")
);
--> statement-breakpoint
CREATE TABLE "cli_tools" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"command" text NOT NULL,
	"install" jsonb,
	"computers" jsonb NOT NULL,
	"bot_scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_tools_bot_scope_ck" CHECK ("cli_tools"."bot_scope" IN ('all', 'some'))
);
--> statement-breakpoint
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_xhs_tier_ck";--> statement-breakpoint
DROP INDEX "accounts_computer_platform_handle_idx";--> statement-breakpoint
DROP INDEX "accounts_owner_platform_none_idx";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "via" text;--> statement-breakpoint
UPDATE "accounts" SET "via" = CASE WHEN "platform" = 'xiaohongshu' THEN 'computer' ELSE 'api' END;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "via" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_tool_bots" ADD CONSTRAINT "cli_tool_bots_tool_id_cli_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."cli_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_tool_bots" ADD CONSTRAINT "cli_tool_bots_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_tool_env" ADD CONSTRAINT "cli_tool_env_tool_id_cli_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."cli_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_tools" ADD CONSTRAINT "cli_tools_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cli_tool_bots_bot_id_idx" ON "cli_tool_bots" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_tools_owner_id_command_idx" ON "cli_tools" USING btree ("owner_id","command");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_computer_platform_via_handle_idx" ON "accounts" USING btree ("computer_id","platform","via","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_platform_via_none_idx" ON "accounts" USING btree ("owner_id","platform","via") WHERE "accounts"."login" = 'none';--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_computer_tier_ck" CHECK ("accounts"."via" <> 'computer' OR "accounts"."tier" <> 'direct_publish');--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_via_ck" CHECK ("accounts"."via" = 'computer' OR "accounts"."platform" <> 'xiaohongshu');--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_via_api_ck" CHECK ("accounts"."via" = 'api' OR "accounts"."platform" <> 'github');