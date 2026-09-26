ALTER TABLE "accounts" ADD COLUMN "login_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "accounts" SET "login_changed_at" = "created_at";
