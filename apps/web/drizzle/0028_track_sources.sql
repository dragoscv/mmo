-- Per-device file ownership for library tracks. Powers the availability
-- states: a track is "connected" (streamable) when at least one of its
-- sources sits on a device that's currently online; "offline" when pinned
-- in the browser's IndexedDB cache; "disconnected" otherwise.
CREATE TABLE IF NOT EXISTS "track_sources" (
    "id" serial PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
    "track_id" integer NOT NULL REFERENCES "tracks"("id") ON DELETE cascade,
    "sha256" text,
    "device_id" text NOT NULL REFERENCES "devices"("id") ON DELETE cascade,
    "filepath" text,
    "companion_track_id" integer,
    "last_seen_at" timestamp DEFAULT now(),
    "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "track_sources_user_idx" ON "track_sources" ("user_id");
CREATE INDEX IF NOT EXISTS "track_sources_track_idx" ON "track_sources" ("track_id");
CREATE INDEX IF NOT EXISTS "track_sources_device_idx" ON "track_sources" ("device_id");
CREATE UNIQUE INDEX IF NOT EXISTS "track_sources_device_track_uniq" ON "track_sources" ("device_id", "track_id");
