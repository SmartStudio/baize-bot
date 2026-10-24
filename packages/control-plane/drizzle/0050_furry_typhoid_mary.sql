ALTER TABLE "routine_runs" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- 回填还能建 run 的记录（running 和等点头的 stopped）。本迁移之前执行者只会被删 Bot 转给主助理，所以这些记录触发时的执行者
-- 就是例行现在的执行者；执行者被删转交过的，填进去的是主助理，它本来就在写者名单里。跑完的记录没人读这一列，留空。
UPDATE "routine_runs" SET "bot_id" = "routines"."bot_id"
FROM "routines"
WHERE "routines"."id" = "routine_runs"."routine_id" AND "routine_runs"."status" IN ('running', 'stopped');
