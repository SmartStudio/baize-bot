CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"platform" text NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_credentials" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_states_owner_platform_idx" ON "oauth_states" USING btree ("owner_id","platform","expires_at" DESC NULLS FIRST,"state" DESC NULLS FIRST);