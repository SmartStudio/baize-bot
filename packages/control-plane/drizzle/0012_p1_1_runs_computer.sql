UPDATE "runs"
SET "computer_id" = "computers"."id"
FROM "computers"
WHERE "runs"."computer_id" IS NULL
	AND "computers"."owner_id" = "runs"."owner_id"
	AND "computers"."kind" = 'local';
