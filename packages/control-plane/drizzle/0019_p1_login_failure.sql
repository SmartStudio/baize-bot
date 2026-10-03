ALTER TABLE "accounts" ADD COLUMN "login_failure" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "login_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_login_failure_ck" CHECK (("accounts"."login_failure" IS NULL) = ("accounts"."login_failed_at" IS NULL));