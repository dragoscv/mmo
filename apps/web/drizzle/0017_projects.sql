-- 0017_projects.sql
-- Unified project persistence: DAW, Sound Editor, Live, Mixer, Visualizations.
--
-- Design notes (see app/src/db/schema-projects.ts):
--   • One row = one project. The heavy structured payload lives in a JSONB
--     `document` column to keep this migration small and enable shipping
--     autosave today. Sub-collections (tracks, clips, automation lanes,
--     plugin state, etc.) can be normalized into their own tables in a
--     later migration when CRDT/multi-cursor collab demands per-field LWW
--     at sub-row granularity. A `yjs_state` BYTEA column is reserved now
--     so future CRDT work doesn't need a column add.
--   • All project tables share the same sync contract: per-row LWW keyed
--     by (user_id, external_id), with `field_versions` for selective field
--     promotion (mirrors the per-field LWW pattern from `tracks`).
--   • `project_snapshots` keeps named + auto-snapshots (immutable doc copy).
--   • `project_assets` is the binary-asset registry: large blobs live in
--     GCS (gcs_object_key) and/or on a Companion's filesystem
--     (companion_path on the device that owns it). Web clients reach them
--     via either /api/projects/assets/[sha256] (cloud) or the companion's
--     /projects/assets/:sha256 endpoint.

------------------------------------------------------------------------
-- DAW projects
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "daw_projects" (
    "id"             SERIAL PRIMARY KEY,
    "user_id"        TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"    TEXT NOT NULL,
    "name"           TEXT NOT NULL DEFAULT 'Untitled',
    "bpm"            REAL,
    "key_camelot"    TEXT,
    "color"          TEXT,
    "is_favorite"    BOOLEAN DEFAULT FALSE,
    "document"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "yjs_state"      BYTEA,
    "created_at"     TIMESTAMP DEFAULT NOW(),
    "updated_at"     TIMESTAMP DEFAULT NOW(),
    "deleted_at"     TIMESTAMP,
    "sync_version"   BIGINT DEFAULT 0,
    "field_versions" JSONB DEFAULT '{}'::jsonb,
    "origin_device_id" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "daw_projects_user_ext_uniq" ON "daw_projects"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "daw_projects_user_updated_idx" ON "daw_projects"("user_id", "updated_at" DESC);

------------------------------------------------------------------------
-- Sound Editor projects
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "editor_projects" (
    "id"             SERIAL PRIMARY KEY,
    "user_id"        TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"    TEXT NOT NULL,
    "name"           TEXT NOT NULL DEFAULT 'Untitled',
    "source_sha256"  TEXT,
    "source_asset_id" INTEGER,
    "duration_ms"    INTEGER,
    "document"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "yjs_state"      BYTEA,
    "created_at"     TIMESTAMP DEFAULT NOW(),
    "updated_at"     TIMESTAMP DEFAULT NOW(),
    "deleted_at"     TIMESTAMP,
    "sync_version"   BIGINT DEFAULT 0,
    "field_versions" JSONB DEFAULT '{}'::jsonb,
    "origin_device_id" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "editor_projects_user_ext_uniq" ON "editor_projects"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "editor_projects_user_updated_idx" ON "editor_projects"("user_id", "updated_at" DESC);

------------------------------------------------------------------------
-- Live sessions (cue stack, MIDI/keyboard mapping)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "live_sessions" (
    "id"             SERIAL PRIMARY KEY,
    "user_id"        TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"    TEXT NOT NULL,
    "name"           TEXT NOT NULL DEFAULT 'Untitled',
    "document"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "yjs_state"      BYTEA,
    "created_at"     TIMESTAMP DEFAULT NOW(),
    "updated_at"     TIMESTAMP DEFAULT NOW(),
    "deleted_at"     TIMESTAMP,
    "sync_version"   BIGINT DEFAULT 0,
    "field_versions" JSONB DEFAULT '{}'::jsonb,
    "origin_device_id" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "live_sessions_user_ext_uniq" ON "live_sessions"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "live_sessions_user_updated_idx" ON "live_sessions"("user_id", "updated_at" DESC);

------------------------------------------------------------------------
-- Mixer setups (channel state, FX chain, presets)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "mixer_setups" (
    "id"             SERIAL PRIMARY KEY,
    "user_id"        TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"    TEXT NOT NULL,
    "name"           TEXT NOT NULL DEFAULT 'Untitled',
    "document"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "yjs_state"      BYTEA,
    "created_at"     TIMESTAMP DEFAULT NOW(),
    "updated_at"     TIMESTAMP DEFAULT NOW(),
    "deleted_at"     TIMESTAMP,
    "sync_version"   BIGINT DEFAULT 0,
    "field_versions" JSONB DEFAULT '{}'::jsonb,
    "origin_device_id" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "mixer_setups_user_ext_uniq" ON "mixer_setups"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "mixer_setups_user_updated_idx" ON "mixer_setups"("user_id", "updated_at" DESC);

------------------------------------------------------------------------
-- Visualization presets
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "visualization_presets" (
    "id"             SERIAL PRIMARY KEY,
    "user_id"        TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"    TEXT NOT NULL,
    "name"           TEXT NOT NULL DEFAULT 'Untitled',
    "kind"           TEXT,
    "document"       JSONB NOT NULL DEFAULT '{}'::jsonb,
    "yjs_state"      BYTEA,
    "created_at"     TIMESTAMP DEFAULT NOW(),
    "updated_at"     TIMESTAMP DEFAULT NOW(),
    "deleted_at"     TIMESTAMP,
    "sync_version"   BIGINT DEFAULT 0,
    "field_versions" JSONB DEFAULT '{}'::jsonb,
    "origin_device_id" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "viz_presets_user_ext_uniq" ON "visualization_presets"("user_id", "external_id");

------------------------------------------------------------------------
-- Snapshots (point-in-time copies, named or auto)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "project_snapshots" (
    "id"             SERIAL PRIMARY KEY,
    "user_id"        TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"    TEXT NOT NULL,
    "project_kind"   TEXT NOT NULL,
    "project_external_id" TEXT NOT NULL,
    "label"          TEXT,
    "auto"           BOOLEAN DEFAULT TRUE,
    "document"       JSONB NOT NULL,
    "git_commit_sha" TEXT,
    "created_at"     TIMESTAMP DEFAULT NOW(),
    "sync_version"   BIGINT DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_snapshots_user_ext_uniq" ON "project_snapshots"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "project_snapshots_project_idx" ON "project_snapshots"("user_id", "project_kind", "project_external_id", "created_at" DESC);

------------------------------------------------------------------------
-- Project assets registry (audio takes, samples, bounces).
-- The bytes live in GCS (gcs_object_key) and/or on a paired Companion
-- (companion_id + companion_path). Web clients negotiate the best
-- source at fetch time.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "project_assets" (
    "id"             SERIAL PRIMARY KEY,
    "user_id"        TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"    TEXT NOT NULL,
    "project_kind"   TEXT,
    "project_external_id" TEXT,
    "sha256"         TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "mime_type"      TEXT,
    "size_bytes"     BIGINT,
    "duration_ms"    INTEGER,
    "gcs_object_key" TEXT,
    "companion_id"   TEXT REFERENCES "devices"("id") ON DELETE SET NULL,
    "companion_path" TEXT,
    "metadata"       JSONB,
    "created_at"     TIMESTAMP DEFAULT NOW(),
    "updated_at"     TIMESTAMP DEFAULT NOW(),
    "deleted_at"     TIMESTAMP,
    "sync_version"   BIGINT DEFAULT 0,
    "field_versions" JSONB DEFAULT '{}'::jsonb,
    "origin_device_id" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_assets_user_ext_uniq" ON "project_assets"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "project_assets_user_sha_idx" ON "project_assets"("user_id", "sha256");
CREATE INDEX IF NOT EXISTS "project_assets_project_idx" ON "project_assets"("user_id", "project_kind", "project_external_id");

------------------------------------------------------------------------
-- Link existing recordings to projects (optional).
------------------------------------------------------------------------
ALTER TABLE "recordings"
    ADD COLUMN IF NOT EXISTS "project_kind" TEXT,
    ADD COLUMN IF NOT EXISTS "project_external_id" TEXT;
CREATE INDEX IF NOT EXISTS "recordings_project_idx" ON "recordings"("user_id", "project_kind", "project_external_id");
