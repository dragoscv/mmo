-- 0002 — FK index coverage.
--
-- Postgres does NOT auto-create indexes for FK columns. Without them,
-- every cascade-delete on a parent (users, tracks, playlists, devices)
-- has to seq-scan the child table. With ~10k tracks per user that's
-- already painful; with 100k+ it's a multi-second stall on a single
-- DELETE. These indexes also cover the JOINs the dashboard / library
-- queries do constantly.
--
-- IF NOT EXISTS so the file is safe to re-run on environments that
-- might already have ad-hoc indexes added by a DBA.

CREATE INDEX IF NOT EXISTS "accounts_user_idx"
    ON "account" ("userId");

CREATE INDEX IF NOT EXISTS "sessions_user_idx"
    ON "session" ("userId");

CREATE INDEX IF NOT EXISTS "user_profiles_user_idx"
    ON "user_profiles" ("user_id");

CREATE INDEX IF NOT EXISTS "devices_user_idx"
    ON "devices" ("user_id");

CREATE INDEX IF NOT EXISTS "device_folders_device_idx"
    ON "device_folders" ("device_id");

CREATE INDEX IF NOT EXISTS "recordings_user_idx"
    ON "recordings" ("user_id");

CREATE INDEX IF NOT EXISTS "tracks_device_idx"
    ON "tracks" ("device_id");

-- Reverse-direction lookups on the pivot tables. The composite PKs
-- already cover (playlist_id, *) and (track_id, *) lookups; these
-- indexes make "find all playlists containing this track" /
-- "find all tracks tagged with this tag" cheap.
CREATE INDEX IF NOT EXISTS "playlist_tracks_track_idx"
    ON "playlist_tracks" ("track_id");

CREATE INDEX IF NOT EXISTS "track_tags_tag_idx"
    ON "track_tags" ("tag_id");

-- cuepoints: only the WHERE-filtered uniq index covers (track_id, external_id).
-- A plain index on track_id makes the cascade cheap for rows lacking external_id.
CREATE INDEX IF NOT EXISTS "cuepoints_track_idx"
    ON "cuepoints" ("track_id");
