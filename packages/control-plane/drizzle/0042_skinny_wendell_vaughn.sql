ALTER TABLE "bots" ADD COLUMN "shape" text;
--> statement-breakpoint
-- 同时创建的旧 Bot 用 id 稳定打破平局；助理和固定人设不占普通队员的轮转位置。
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY owner_id ORDER BY created_at, id) - 1 AS position
  FROM bots
  WHERE role <> 'assistant' AND preset IS NULL
)
UPDATE bots SET shape = (ARRAY['pillow', 'cloud', 'triangle', 'bean', 'droplet', 'arch', 'leaf', 'pudding'])[(ranked.position % 8 + 1)::int]
FROM ranked WHERE bots.id = ranked.id;
--> statement-breakpoint
UPDATE bots SET shape = CASE
  WHEN role = 'assistant' THEN 'pillow'
  WHEN preset = 'leopard' THEN 'triangle'
  WHEN preset = 'old_k' THEN 'arch'
  WHEN preset = 'jasmine' THEN 'leaf'
  WHEN preset = 'dalu' THEN 'pudding'
  WHEN preset = 'xiaoqi' THEN 'bean'
  WHEN preset = 'laobai' THEN 'pillow'
  ELSE 'pillow'
END WHERE shape IS NULL;
--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "shape" SET NOT NULL;
