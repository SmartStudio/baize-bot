CREATE TABLE "poker_act_receipts" (
	"run_id" text NOT NULL,
	"call_id" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poker_act_receipts_run_id_call_id_pk" PRIMARY KEY("run_id","call_id")
);
--> statement-breakpoint
ALTER TABLE "poker_hands" DROP CONSTRAINT "poker_hands_status_check";--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "dispatch_seq" integer;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "dispatch_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_act_receipts" ADD CONSTRAINT "poker_act_receipts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 进行中的手把当前决策点已发出的次数从旧标记消息数过来，迁移前后重派上限不变。
UPDATE "poker_hands" SET "dispatch_seq" = "counted"."seq", "dispatch_count" = "counted"."n"
FROM (
	SELECT "h"."id", "e"."seq", count("m"."id")::int AS "n"
	FROM "poker_hands" "h"
	CROSS JOIN LATERAL (SELECT count(*)::int AS "seq" FROM "poker_events" WHERE "hand_id" = "h"."id") "e"
	JOIN "messages" "m" ON "m"."group_id" = "h"."group_id" AND "m"."body"->>'text' = '牌桌决策点 ' || "h"."id" || '/' || "e"."seq"
	WHERE "h"."status" = 'playing'
	GROUP BY "h"."id", "e"."seq"
) "counted"
WHERE "poker_hands"."id" = "counted"."id";--> statement-breakpoint
-- 旧回执是 messages 里 id 以 poker-result: 开头的隐藏行，正文是整条 poker_result 报文。搬到专表后删掉原行：
-- 运行器重启后可能拿同一个 callId 重发，没搬的话会被当成新动作再处理一次。run 已删的回执没有归属，不搬。
INSERT INTO "poker_act_receipts" ("run_id", "call_id", "result", "created_at")
SELECT "r"."body"->>'runId', "r"."body"->>'callId', "r"."body"->'result', "r"."created_at"
FROM (
	SELECT ("body"->>'text')::jsonb AS "body", "created_at"
	FROM "messages"
	WHERE "id" LIKE 'poker-result:%' AND "body"->>'kind' = 'system' AND "body"->>'text' LIKE '{%'
) "r"
JOIN "runs" ON "runs"."id" = "r"."body"->>'runId'
WHERE "r"."body"->>'type' = 'poker_result'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "messages" WHERE "id" LIKE 'poker-result:%';--> statement-breakpoint
ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_dispatch_check" CHECK (("poker_hands"."dispatch_seq" IS NULL) = ("poker_hands"."dispatch_count" = 0));--> statement-breakpoint
ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_status_check" CHECK ("poker_hands"."status" IN ('playing', 'complete', 'abandoned'));
