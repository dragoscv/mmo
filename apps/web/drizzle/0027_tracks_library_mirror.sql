-- Cloud library source-of-truth: mirror the companion SQLite `tracks`
-- columns the web Library UI relies on but which the cloud table never had.
-- Without these, sync-apply.ts silently dropped the fields (Drizzle ignores
-- unknown columns) so cloud Postgres could never serve the library on a
-- second device. All nullable so partial sync payloads never fail an insert.
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "filepath" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "filename" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "duration" integer;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "is_processed" boolean DEFAULT false;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "tags" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "musicbrainz_id" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "release_mbid" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "isrc" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "lyrics" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "synced_lyrics" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "related_track_id" integer;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "is_offline_available" boolean DEFAULT false;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_status" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_vocals_path" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_drums_path" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_bass_path" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_melody_path" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_analyzed_at" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_model" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "stems_error" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "loudness_lufs" real;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "loudness_true_peak_dbfs" real;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "loudness_range_lu" real;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "acoustid_fingerprint" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "acoustid_id" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "bpm_confidence" real;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "key_confidence" real;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "beats" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "downbeats" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "chord_progression" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "structure_segments" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "dsp_analyzed_at" text;
