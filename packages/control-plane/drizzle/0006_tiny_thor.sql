ALTER TABLE "runs" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "is_routine" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
UPDATE "runs" AS r SET "owner_id" = COALESCE(b."owner_id", g."owner_id"),
  "is_routine" = r."routine_run_id" IS NOT NULL
FROM "runs" AS source
LEFT JOIN "bots" AS b ON b."id" = source."bot_id"
LEFT JOIN "groups" AS g ON g."id" = source."group_id"
WHERE r."id" = source."id";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_owner_id_started_at_idx" ON "runs" USING btree ("owner_id","started_at");
