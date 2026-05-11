-- Add AI-suggested BPM/key columns to tracks (cloud mirror only).
-- Suggestions live here until the user confirms them, at which point the
-- value is copied into the canonical bpm / key_camelot columns and synced
-- back to the companion through the normal field-versioned flow.

ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "ai_bpm" real;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "ai_key" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "ai_confidence" real;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "ai_model" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "ai_analyzed_at" timestamp;
