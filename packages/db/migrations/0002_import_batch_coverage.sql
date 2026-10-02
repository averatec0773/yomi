-- Days an imported file covers (import data freshness). Text columns COLLATE "C", added by hand.
ALTER TABLE "import_batches" ADD COLUMN "period_start" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "period_end" text COLLATE "C";--> statement-breakpoint
-- Backfill: statement files whose name carries their date span, as Alipay and WeChat name exports
-- ("(20260701-20260929)"). The file may have been exported before the end day was over, so the end is capped at
-- the day before the batch was imported (UTC). Names without such a span stay null; freshness then falls back to
-- the newest row of the source.
UPDATE "import_batches" AS b
SET
  "period_start" = substr(x.m[1], 1, 4) || '-' || substr(x.m[1], 5, 2) || '-' || substr(x.m[1], 7, 2),
  "period_end" = least(
    substr(x.m[2], 1, 4) || '-' || substr(x.m[2], 5, 2) || '-' || substr(x.m[2], 7, 2),
    to_char(left(b."created_at", 10)::date - 1, 'YYYY-MM-DD')
  )
FROM (
  SELECT "id", regexp_match("file_name", '(20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))\s*[-_~至到]\s*(20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))') AS m
  FROM "import_batches"
) AS x
WHERE x."id" = b."id" AND x.m IS NOT NULL AND b."source" IN ('alipay', 'wechat', 'icbc_pdf', 'boa_csv') AND b."period_end" IS NULL;
