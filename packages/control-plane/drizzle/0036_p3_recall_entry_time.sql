ALTER TABLE "work_entries" ADD COLUMN "entry_at" timestamp with time zone;
--> statement-breakpoint
CREATE FUNCTION work_entry_timestamp(line text) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text;
BEGIN
  -- 行里允许 JSON 转义的 NUL，jsonb 不收；只去掉前面反斜杠个数为偶数的 \u0000。
  raw := regexp_replace(line, '(?<!\\)((?:\\\\)*)\\u0000', '\1', 'g')::jsonb ->> 'timestamp';
  IF raw ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$' THEN
    RETURN date_trunc('milliseconds', raw::timestamptz);
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE FUNCTION work_entries_set_entry_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stream = 'chat' AND NEW.pi_type = 'message' THEN
    NEW.entry_at := work_entry_timestamp(NEW.line);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER work_entries_entry_at BEFORE INSERT ON "work_entries" FOR EACH ROW EXECUTE FUNCTION work_entries_set_entry_at();
--> statement-breakpoint
UPDATE "work_entries" SET "entry_at" = work_entry_timestamp("line") WHERE "stream" = 'chat' AND "pi_type" = 'message';
