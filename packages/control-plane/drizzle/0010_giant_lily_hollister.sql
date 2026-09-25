ALTER TABLE "approvals" ADD COLUMN "view" jsonb;--> statement-breakpoint
UPDATE "approvals"
SET "view" = jsonb_build_object(
  'kind', 'mcp',
  'server', '',
  'tool', "tool",
  'params', '[]'::jsonb,
  'raw', "summary"
);--> statement-breakpoint
UPDATE "messages"
SET "body" = ("body" - 'argsSummary') || jsonb_build_object(
  'runId', '',
  'view', jsonb_build_object(
    'kind', 'mcp',
    'server', '',
    'tool', "body" ->> 'tool',
    'params', '[]'::jsonb,
    'raw', COALESCE("body" ->> 'argsSummary', '')
  )
)
WHERE "body" ->> 'kind' = 'tool_call';--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "view" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "summary";
