ALTER TABLE "runs" ADD COLUMN "charged_at" timestamp with time zone;
--> statement-breakpoint
-- 迁移前结束的 run 账早就结过了，回填成已结账，不然老 run 晚到的 run_done 会再出一张费用卡。
UPDATE "runs" SET "charged_at" = "ended_at" WHERE "ended_at" IS NOT NULL;
