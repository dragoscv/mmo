-- 0018_projects_normalized.sql
--
-- Phase 1 (normalization) + Phase 3 (GitHub OAuth) + Phase 5 (storage tier).
--
-- Per-row LWW pattern is identical to 0017: each sub-row carries
-- `(user_id, external_id)` as its sync key, `field_versions JSONB`
-- for per-field clocks, and a `parent_external_id` linking it to the
-- enclosing project. The parent JSONB `document` column still exists
-- on the head project tables and is what server actions write *in
-- addition* to the normalized rows during the rolling migration; once
-- all reads have moved to the sub-tables we can drop `document`.
--
-- "Mid-normalization": we split at the level where two users editing
-- the same project would actually conflict (tracks, clips, cues,
-- channels, layers). Deep-nested data with no realistic concurrent-edit
-- collision (a track's insert FX chain, a clip's MIDI note list, a
-- cue's MIDI mapping) stays as JSONB on the parent sub-row.

------------------------------------------------------------------------
-- Storage tier toggle (Phase 5) + Git linkage on each project kind
------------------------------------------------------------------------
ALTER TABLE "daw_projects"           ADD COLUMN IF NOT EXISTS "storage_tier" TEXT DEFAULT 'cloud';
ALTER TABLE "daw_projects"           ADD COLUMN IF NOT EXISTS "git_repo" TEXT;
ALTER TABLE "editor_projects"        ADD COLUMN IF NOT EXISTS "storage_tier" TEXT DEFAULT 'cloud';
ALTER TABLE "editor_projects"        ADD COLUMN IF NOT EXISTS "git_repo" TEXT;
ALTER TABLE "live_sessions"          ADD COLUMN IF NOT EXISTS "storage_tier" TEXT DEFAULT 'cloud';
ALTER TABLE "live_sessions"          ADD COLUMN IF NOT EXISTS "git_repo" TEXT;
ALTER TABLE "mixer_setups"           ADD COLUMN IF NOT EXISTS "storage_tier" TEXT DEFAULT 'cloud';
ALTER TABLE "mixer_setups"           ADD COLUMN IF NOT EXISTS "git_repo" TEXT;
ALTER TABLE "visualization_presets"  ADD COLUMN IF NOT EXISTS "storage_tier" TEXT DEFAULT 'cloud';
ALTER TABLE "visualization_presets"  ADD COLUMN IF NOT EXISTS "git_repo" TEXT;

------------------------------------------------------------------------
-- DAW: tracks + clips
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "daw_tracks" (
    "id"                  SERIAL PRIMARY KEY,
    "user_id"             TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"         TEXT NOT NULL,
    "parent_external_id"  TEXT NOT NULL,
    "track_index"         INTEGER NOT NULL DEFAULT 0,
    "name"                TEXT NOT NULL DEFAULT 'Track',
    "kind"                TEXT NOT NULL DEFAULT 'audio',
    "color"               TEXT,
    "volume"              REAL DEFAULT 0.8,
    "pan"                 REAL DEFAULT 0,
    "muted"               BOOLEAN DEFAULT FALSE,
    "soloed"              BOOLEAN DEFAULT FALSE,
    "armed"               BOOLEAN DEFAULT FALSE,
    "frozen"              BOOLEAN DEFAULT FALSE,
    "height"              INTEGER DEFAULT 90,
    "input_source"        TEXT,
    "output_target"       TEXT,
    "instrument_id"       TEXT,
    "inserts"             JSONB DEFAULT '[]'::jsonb,
    "sends"               JSONB DEFAULT '[]'::jsonb,
    "automation_lanes"    JSONB DEFAULT '[]'::jsonb,
    "created_at"          TIMESTAMP DEFAULT NOW(),
    "updated_at"          TIMESTAMP DEFAULT NOW(),
    "deleted_at"          TIMESTAMP,
    "sync_version"        BIGINT DEFAULT 0,
    "field_versions"      JSONB DEFAULT '{}'::jsonb,
    "origin_device_id"    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "daw_tracks_user_ext_uniq" ON "daw_tracks"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "daw_tracks_parent_idx" ON "daw_tracks"("user_id", "parent_external_id", "track_index");

CREATE TABLE IF NOT EXISTS "daw_clips" (
    "id"                  SERIAL PRIMARY KEY,
    "user_id"             TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"         TEXT NOT NULL,
    "parent_external_id"  TEXT NOT NULL,
    "track_external_id"   TEXT NOT NULL,
    "kind"                TEXT NOT NULL DEFAULT 'audio',
    "name"                TEXT NOT NULL DEFAULT 'Clip',
    "position"            REAL DEFAULT 0,
    "length"              REAL DEFAULT 4,
    "color"               TEXT,
    "muted"               BOOLEAN DEFAULT FALSE,
    "audio"               JSONB,
    "midi"                JSONB,
    "automation_data"     JSONB,
    "created_at"          TIMESTAMP DEFAULT NOW(),
    "updated_at"          TIMESTAMP DEFAULT NOW(),
    "deleted_at"          TIMESTAMP,
    "sync_version"        BIGINT DEFAULT 0,
    "field_versions"      JSONB DEFAULT '{}'::jsonb,
    "origin_device_id"    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "daw_clips_user_ext_uniq" ON "daw_clips"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "daw_clips_track_idx" ON "daw_clips"("user_id", "track_external_id");
CREATE INDEX IF NOT EXISTS "daw_clips_parent_idx" ON "daw_clips"("user_id", "parent_external_id");

------------------------------------------------------------------------
-- Sound Editor: regions (selections, edits, fx chain per region)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "editor_regions" (
    "id"                  SERIAL PRIMARY KEY,
    "user_id"             TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"         TEXT NOT NULL,
    "parent_external_id"  TEXT NOT NULL,
    "name"                TEXT NOT NULL DEFAULT 'Region',
    "start_ms"            INTEGER DEFAULT 0,
    "end_ms"              INTEGER DEFAULT 0,
    "color"               TEXT,
    "fx_chain"            JSONB DEFAULT '[]'::jsonb,
    "edit_ops"            JSONB DEFAULT '[]'::jsonb,
    "markers"             JSONB DEFAULT '[]'::jsonb,
    "created_at"          TIMESTAMP DEFAULT NOW(),
    "updated_at"          TIMESTAMP DEFAULT NOW(),
    "deleted_at"          TIMESTAMP,
    "sync_version"        BIGINT DEFAULT 0,
    "field_versions"      JSONB DEFAULT '{}'::jsonb,
    "origin_device_id"    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "editor_regions_user_ext_uniq" ON "editor_regions"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "editor_regions_parent_idx" ON "editor_regions"("user_id", "parent_external_id");

------------------------------------------------------------------------
-- Live: cues (a single button / mapping in a setlist)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "live_cues" (
    "id"                  SERIAL PRIMARY KEY,
    "user_id"             TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"         TEXT NOT NULL,
    "parent_external_id"  TEXT NOT NULL,
    "cue_index"           INTEGER NOT NULL DEFAULT 0,
    "name"                TEXT NOT NULL DEFAULT 'Cue',
    "color"               TEXT,
    "action"              TEXT,
    "mappings"            JSONB DEFAULT '[]'::jsonb,
    "fx_chain"            JSONB DEFAULT '[]'::jsonb,
    "created_at"          TIMESTAMP DEFAULT NOW(),
    "updated_at"          TIMESTAMP DEFAULT NOW(),
    "deleted_at"          TIMESTAMP,
    "sync_version"        BIGINT DEFAULT 0,
    "field_versions"      JSONB DEFAULT '{}'::jsonb,
    "origin_device_id"    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "live_cues_user_ext_uniq" ON "live_cues"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "live_cues_parent_idx" ON "live_cues"("user_id", "parent_external_id", "cue_index");

------------------------------------------------------------------------
-- Mixer: channels
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "mixer_channels" (
    "id"                  SERIAL PRIMARY KEY,
    "user_id"             TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"         TEXT NOT NULL,
    "parent_external_id"  TEXT NOT NULL,
    "channel_index"       INTEGER NOT NULL DEFAULT 0,
    "name"                TEXT NOT NULL DEFAULT 'Channel',
    "color"               TEXT,
    "volume"              REAL DEFAULT 0.8,
    "pan"                 REAL DEFAULT 0,
    "muted"               BOOLEAN DEFAULT FALSE,
    "soloed"              BOOLEAN DEFAULT FALSE,
    "input_source"        TEXT,
    "fx_slots"            JSONB DEFAULT '[]'::jsonb,
    "sends"               JSONB DEFAULT '[]'::jsonb,
    "eq"                  JSONB,
    "created_at"          TIMESTAMP DEFAULT NOW(),
    "updated_at"          TIMESTAMP DEFAULT NOW(),
    "deleted_at"          TIMESTAMP,
    "sync_version"        BIGINT DEFAULT 0,
    "field_versions"      JSONB DEFAULT '{}'::jsonb,
    "origin_device_id"    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "mixer_channels_user_ext_uniq" ON "mixer_channels"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "mixer_channels_parent_idx" ON "mixer_channels"("user_id", "parent_external_id", "channel_index");

------------------------------------------------------------------------
-- Visualizations: layers (a single render layer in a preset stack)
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "viz_layers" (
    "id"                  SERIAL PRIMARY KEY,
    "user_id"             TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "external_id"         TEXT NOT NULL,
    "parent_external_id"  TEXT NOT NULL,
    "layer_index"         INTEGER NOT NULL DEFAULT 0,
    "name"                TEXT NOT NULL DEFAULT 'Layer',
    "kind"                TEXT NOT NULL DEFAULT 'waveform',
    "enabled"             BOOLEAN DEFAULT TRUE,
    "blend_mode"          TEXT,
    "opacity"             REAL DEFAULT 1,
    "params"              JSONB DEFAULT '{}'::jsonb,
    "modulators"          JSONB DEFAULT '[]'::jsonb,
    "created_at"          TIMESTAMP DEFAULT NOW(),
    "updated_at"          TIMESTAMP DEFAULT NOW(),
    "deleted_at"          TIMESTAMP,
    "sync_version"        BIGINT DEFAULT 0,
    "field_versions"      JSONB DEFAULT '{}'::jsonb,
    "origin_device_id"    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "viz_layers_user_ext_uniq" ON "viz_layers"("user_id", "external_id");
CREATE INDEX IF NOT EXISTS "viz_layers_parent_idx" ON "viz_layers"("user_id", "parent_external_id", "layer_index");

------------------------------------------------------------------------
-- Phase 3: per-user OAuth tokens (currently only GitHub; provider-keyed
-- so we can add Dropbox / Google Drive later without a migration).
-- Access tokens are stored encrypted with libsodium secretbox using the
-- env var AUTH_TOKEN_ENC_KEY (32 bytes, base64).
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user_oauth_tokens" (
    "id"               SERIAL PRIMARY KEY,
    "user_id"          TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "provider"         TEXT NOT NULL,
    "provider_user_id" TEXT,
    "login"            TEXT,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "scope"            TEXT,
    "expires_at"       TIMESTAMP,
    "created_at"       TIMESTAMP DEFAULT NOW(),
    "updated_at"       TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_oauth_tokens_unique"
    ON "user_oauth_tokens"("user_id", "provider");
