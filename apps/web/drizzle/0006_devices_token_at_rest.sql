-- 0006 — Encrypt device bearer tokens at rest.
--
-- Before this migration `devices.token` stored the plaintext bearer credential
-- the web app forwards to companion HTTP endpoints (X-Device-Token). A single
-- read-side compromise of the database (backup leak, replica access, future
-- SQL-injection elsewhere) yielded every device's bearer forever — and the
-- token never rotated.
--
-- After this migration:
--   * `token_hash` (HMAC-SHA256 of the plaintext, hex) is the indexable
--     equality key used by inbound auth lookups (heartbeat / validate / sync).
--     Hashes are not reversible and the HMAC key is derived from AUTH_SECRET,
--     which is not in the DB.
--   * `token_encrypted` (AES-256-GCM, "v1:b64(nonce):b64(ciphertext+tag)")
--     is what the web server decrypts when it needs to forward the bearer to
--     a companion. Plaintext never lives at rest again.
--   * `token` (plaintext) becomes nullable so the migration helper can null
--     each row after backfilling the new columns. After every device has
--     re-issued or hit a lookup once, a follow-up migration can drop the
--     column entirely.
--
-- Backfill happens lazily on the next inbound or outbound use of each row
-- (see app/src/lib/device-token.ts), which keeps this migration zero-downtime
-- and avoids needing AUTH_SECRET inside drizzle-kit.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS token_hash TEXT,
    ADD COLUMN IF NOT EXISTS token_encrypted TEXT;

ALTER TABLE devices
    ALTER COLUMN token DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS devices_token_hash_unique
    ON devices(token_hash);
