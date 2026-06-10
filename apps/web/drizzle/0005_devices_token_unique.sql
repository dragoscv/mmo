-- 0005 — Unique index on devices.token.
--
-- `devices.token` is the bearer credential checked on every authenticated
-- request to `/api/sync` (high-volume, every device polling) and to
-- `/api/devices/validate`. The lookup has always been
--
--     SELECT … FROM devices WHERE token = $1
--
-- but the column had neither a UNIQUE constraint nor an index, so:
--
--   1. Each request did a sequential scan of the whole `devices` table.
--      Cost grew linearly with total device count across all users —
--      a built-in amplifier for any polling load.
--   2. Two devices could theoretically share a token (random UUIDs make
--      collision astronomical, but the schema permitted it; an admin
--      script bug or a recovered-from-backup duplicate would silently
--      authenticate as whichever row Postgres returned first).
--
-- A plain `CREATE UNIQUE INDEX IF NOT EXISTS` is correct here:
-- random UUIDs can't collide in practice, so the build won't fail,
-- and we get O(log n) lookups + a hard duplicate-prevention guarantee.

CREATE UNIQUE INDEX IF NOT EXISTS "devices_token_uniq"
    ON "devices" ("token");
