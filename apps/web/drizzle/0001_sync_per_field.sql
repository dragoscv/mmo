-- 0001 — Per-field LWW columns + cross-device external IDs.
--
-- Adds the columns the new POST /api/sync handler needs to do
-- per-field merge on `tracks` (high-conflict: companion analyses BPM/key
-- while the user edits rating/tags from the web at the same time) and
-- row-level LWW on `playlists`/`cuepoints` keyed by a stable
-- companion-minted UUID instead of the cloud's serial id.

ALTER TABLE "tracks"
    ADD COLUMN IF NOT EXISTS "field_versions" jsonb DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS "tracks_user_sha_uniq"
    ON "tracks" ("user_id", "sha256")
    WHERE "sha256" IS NOT NULL;

ALTER TABLE "playlists"
    ADD COLUMN IF NOT EXISTS "external_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "playlists_user_external_uniq"
    ON "playlists" ("user_id", "external_id")
    WHERE "external_id" IS NOT NULL;

ALTER TABLE "cuepoints"
    ADD COLUMN IF NOT EXISTS "external_id" text;

ALTER TABLE "cuepoints"
    ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS "cuepoints_track_external_uniq"
    ON "cuepoints" ("track_id", "external_id")
    WHERE "external_id" IS NOT NULL;
