-- Cache companion-owned folders in the cloud DB so /devices paints instantly
-- without the companion being online. Truth still lives in electron-store;
-- these rows are a write-through mirror updated on every successful
-- list/add/remove/kind/watch call.

ALTER TABLE "device_folders" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "device_folders" ADD COLUMN IF NOT EXISTS "watch" boolean DEFAULT false;

-- Dedupe any pre-existing duplicates before adding the unique index.
DELETE FROM "device_folders" a
USING "device_folders" b
WHERE a.id > b.id
  AND a.device_id = b.device_id
  AND a.path = b.path;

CREATE UNIQUE INDEX IF NOT EXISTS "device_folders_device_path_uniq"
    ON "device_folders" ("device_id", "path");
