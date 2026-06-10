-- 0007_drop_devices_token_plaintext.sql
--
-- Follow-up to 0006_devices_token_at_rest.sql.
--
-- 0006 added `token_hash` (HMAC-SHA256, indexed) and `token_encrypted`
-- (AES-256-GCM envelope), made `token` nullable, and wired every
-- read/write site to backfill the new columns lazily on first use.
--
-- After 0006 has been live for a full sync window (devices reconnect on
-- their own heartbeat / scan / sync cadence and self-upgrade), the
-- plaintext column is unused. This migration drops it so a future
-- backup leak / replica compromise / errant log line cannot resurface
-- the bearer credential.
--
-- ROLLBACK: this migration is destructive. If you need to roll back,
-- recreate the column as `ALTER TABLE devices ADD COLUMN token TEXT`
-- and re-pair every device (the encrypted blob is decryptable but we
-- intentionally don't expose a "downgrade" code path in the app).
--
-- PRE-DEPLOY CHECK (run in psql before applying):
--   SELECT count(*) FROM devices WHERE token IS NOT NULL;
-- Expected: 0. If non-zero, either rerun the app long enough for those
-- devices to reconnect, or hand-migrate them via the device-token lib.

-- Drop the unique index on the (now-dead) plaintext column first so the
-- column drop is cheap.
DROP INDEX IF EXISTS devices_token_unique;

ALTER TABLE devices DROP COLUMN IF EXISTS token;
