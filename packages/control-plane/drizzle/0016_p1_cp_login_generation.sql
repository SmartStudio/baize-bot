ALTER TABLE "accounts" ADD COLUMN "login_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "claimed_login_generation" integer;