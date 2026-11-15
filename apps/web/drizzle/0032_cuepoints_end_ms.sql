-- 0032 — A cue loop is ONE cloud row with an end.
--
-- Crate / cue sync phase 1 (docs/decks/crate-sync-design.md, D3 + question 8):
-- the MMO Server relays DJ cue points to the cloud. Before this change a loop
-- was two rows keyed by the same `external_id` (kind `loop_in` / `loop_out`);
-- the Decks model has ONE cue with a start and an end, so the table gains the
-- end column and a loop becomes a single `loop` row.
--
-- Backward compatible: the column is nullable, so the existing `loop_in` /
-- `loop_out` pairs keep working until the server re-relays them as one row.
--
-- PREPARED ONLY — the production run is a separate, owner-approved step
-- (`pnpm db:status:prod` then `pnpm db:migrate:prod`, after a backup).

ALTER TABLE "cuepoints"
    ADD COLUMN IF NOT EXISTS "end_ms" integer;
