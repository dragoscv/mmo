# Drizzle migrations

The production migration runner is **not** `drizzle-kit migrate` — it's
`app/scripts/apply-sql-migrations.mjs`, driven by these npm scripts:

| Script | Purpose |
| --- | --- |
| `pnpm db:status` | Show pending vs applied migrations against local DB. |
| `pnpm db:status:prod` | Same, against production (pulls `.env` from Vercel first). |
| `pnpm db:migrate` | Apply pending migrations to local DB. |
| `pnpm db:migrate:prod` | Apply to production. |
| `pnpm db:mark-applied:prod` | Baseline a fresh DB without executing SQL. |

The runner uses a `_manual_migrations(tag TEXT PRIMARY KEY)` tracker
table (not `drizzle.__drizzle_migrations`) and serialises concurrent
runs via `pg_advisory_lock`. Every migration runs in its own
transaction, so a failed statement rolls back both the schema change
**and** the tracker insert — the next run will retry from the same tag.

## Snapshot drift

`meta/_journal.json` lists all 17 SQL files, but **only
`0000_snapshot.json` exists**. `drizzle-kit generate` diffs the current
`src/db/schema.ts` against the latest snapshot, so running it today
would emit a massive migration re-doing 0001–0016.

To author a new migration safely until snapshots are regenerated:

1. Hand-author `app/drizzle/NNNN_<name>.sql`.
2. Append a new entry to `meta/_journal.json` (`idx`, `version: "7"`,
   `when: Date.now()`, `tag`, `breakpoints: true`).
3. Run `pnpm db:migrate` (and `db:migrate:prod`).
4. The pre-commit guard (`app/scripts/check-migrations.mjs`) requires a
   matching `NNNN_*.sql` file when `src/db/**` changes.

To rebuild snapshots (one-off cleanup, not yet done):

```bash
# 1. Make a one-shot snapshot from the current schema:
pnpm exec drizzle-kit generate --name=baseline
# 2. Delete the generated SQL (it's already applied):
rm app/drizzle/NNNN_baseline.sql
# 3. Keep meta/NNNN_snapshot.json as the new baseline; future generates
#    will diff from it.
```
