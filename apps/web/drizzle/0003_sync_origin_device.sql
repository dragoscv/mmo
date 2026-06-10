-- 0003 — Origin-device tracking on the sync log.
--
-- The `GET /api/sync?cursor=…` endpoint is supposed to skip a device's
-- own pushes so it doesn't re-pull its own writes. The implementation
-- and schema both forgot the column, so every push triggered an
-- echo-pull on the next poll. With per-field LWW the data still
-- converges, but it's wasted bandwidth + CPU and pollutes the diff
-- log on the companion side.
--
-- NULL means "cloud-side write" (web app, server action) — those
-- legitimately fan out to every device including the originator.

ALTER TABLE "sync_log"
    ADD COLUMN IF NOT EXISTS "origin_device_id" text;

-- Composite index covers the new GET filter:
--   WHERE user_id = ? AND id > ? AND (origin_device_id IS NULL OR origin_device_id <> ?)
-- The leading (user_id, id) index already supports the prefix; this
-- partial index keeps the (origin_device_id != ?) selectivity sharp
-- without bloating the table.
CREATE INDEX IF NOT EXISTS "sync_log_origin_idx"
    ON "sync_log" ("user_id", "id")
    WHERE "origin_device_id" IS NOT NULL;
