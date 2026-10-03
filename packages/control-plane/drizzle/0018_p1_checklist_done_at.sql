-- 清单项补上 doneAt 键。迁移前勾上的不知道是哪天勾的，记 null，不算进任何一周。
UPDATE "tasks"
SET "checklist" = (
  SELECT jsonb_agg(item || '{"doneAt": null}'::jsonb ORDER BY ord)
  FROM jsonb_array_elements("checklist") WITH ORDINALITY AS listed(item, ord)
)
WHERE jsonb_array_length("checklist") > 0;
