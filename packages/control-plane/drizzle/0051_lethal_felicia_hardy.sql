ALTER TABLE "metric_samples" ADD COLUMN "metric" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_metric" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "metric_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "metric_sources" = jsonb_build_array("metric_source") WHERE "metric_source" IS NOT NULL;--> statement-breakpoint
UPDATE "metric_samples" SET "metric" = CASE "tasks"."metric_source"->>'kind'
  WHEN 'github_stars' THEN 'github_stars:' || ("tasks"."metric_source"->>'repo')
  WHEN 'reported' THEN 'reported:' || ("tasks"."metric_source"->>'label')
END
FROM "tasks"
WHERE "tasks"."group_id" = "metric_samples"."group_id" AND "tasks"."metric_source" IS NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "goal_metric" = CASE "metric_source"->>'kind'
  WHEN 'github_stars' THEN 'github_stars:' || ("metric_source"->>'repo')
  WHEN 'reported' THEN 'reported:' || ("metric_source"->>'label')
END
WHERE "goal_target" IS NOT NULL AND "metric_source" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "metric_source";
