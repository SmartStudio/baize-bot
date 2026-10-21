-- skill_offer 卡的正文从平铺的 name、steps 改成一个 change。旧卡都是「存成 skill」，包成 op = add、没有来源。
UPDATE "messages"
SET "body" = ("body" - 'name' - 'steps') || jsonb_build_object(
  'change', jsonb_build_object('op', 'add', 'name', "body" -> 'name', 'steps', "body" -> 'steps', 'origin', NULL)
)
WHERE "body" ->> 'kind' = 'skill_offer' AND NOT ("body" ? 'change');
