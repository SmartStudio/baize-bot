DROP TRIGGER "work_entries_entry_at" ON "work_entries";
--> statement-breakpoint
DROP FUNCTION work_entries_set_entry_at();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION work_entry_timestamp(line text) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  value jsonb;
  raw text;
  at timestamptz;
BEGIN
  -- 删除转义 NUL 会合并不同的 JSON 键；无法无损解析的旧行只回退，不猜时间。
  IF line ~ '(?<!\\)(?:\\\\)*\\u0000' THEN
    RETURN NULL;
  END IF;
  value := line::jsonb;
  IF jsonb_typeof(value -> 'timestamp') IS DISTINCT FROM 'string' THEN
    RETURN NULL;
  END IF;
  raw := value ->> 'timestamp';
  IF raw !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$'
    OR (substring(raw FROM 12 FOR 2) = '24' AND raw !~ 'T24:00:00(\.0{1,9})?(Z|[+-]\d{2}:\d{2})$') THEN
    RETURN NULL;
  END IF;
  -- PostgreSQL 会先舍入到微秒，必须在转换之前截去毫秒之后的小数。
  raw := regexp_replace(raw, '(\.\d{3})\d+', '\1');
  at := raw::timestamptz;
  -- 与应用 Date 的 ISO 序列化范围一致，避免偏移跨入 year 0000 或扩展年。
  IF at < '0001-01-01T00:00:00Z'::timestamptz OR at >= '10000-01-01T00:00:00Z'::timestamptz THEN
    RETURN NULL;
  END IF;
  RETURN at;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;
--> statement-breakpoint
UPDATE "work_entries" SET "entry_at" = work_entry_timestamp("line") WHERE "stream" = 'chat' AND "pi_type" = 'message';
--> statement-breakpoint
DROP FUNCTION work_entry_timestamp(text);
