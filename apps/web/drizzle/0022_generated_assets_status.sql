-- Track Replicate prediction lifecycle so we can poll T1 jobs that exceeded
-- the synchronous wait window, and so the /generate UI can show truthful status.
ALTER TABLE "generated_assets"
    ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending';

ALTER TABLE "generated_assets"
    ADD COLUMN IF NOT EXISTS "replicate_prediction_id" text;

ALTER TABLE "generated_assets"
    ADD COLUMN IF NOT EXISTS "error" text;

ALTER TABLE "generated_assets"
    ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

-- Backfill: rows that already have a file are ready.
UPDATE "generated_assets" SET "status" = 'ready' WHERE "file_path" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "generated_assets_pending_idx"
    ON "generated_assets" ("status")
    WHERE "status" = 'pending' AND "replicate_prediction_id" IS NOT NULL;
