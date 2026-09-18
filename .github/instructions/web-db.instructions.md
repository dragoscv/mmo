---
applyTo: "apps/web/src/db/**, apps/web/drizzle/**, packages/db/**"
description: "Drizzle + Postgres for apps/web: .env.local is PRODUCTION, migrations need .sql + journal, custom runner"
---

# Web database (Drizzle ORM, PostgreSQL on GCP Cloud SQL)

## The one thing to never forget
**`apps/web/.env.local` `DATABASE_URL` points at PRODUCTION** (Cloud SQL, `mmo-mw-prod`). Every
`pnpm db:*` command without `--env=<file>` runs against prod. `pnpm db:migrate` = prod migration.
- Always `pnpm db:status` (or `db:status:prod`) first and read the pending list.
- Never run `db:migrate` "to see what happens". Ask the user before any migration, `--mark-applied`, or
  anything that DROPs/TRUNCATEs/deletes broadly (security rule: irreversible actions need consent).
- Local/other DB: `node scripts/apply-sql-migrations.mjs --env=<path>` or `--env=-` with ambient env.

## Schema change procedure
1. Edit `apps/web/src/db/schema.ts` (identity columns, `withTimezone: true`, relational queries).
2. Write the migration by hand or `pnpm db:generate` (drizzle-kit) → new `apps/web/drizzle/NNNN_<name>.sql`
   with the next numeric prefix (last today: `0029_device_auth_codes.sql`).
3. Add the entry to `apps/web/drizzle/meta/_journal.json` (`idx`, `tag`). Husky `check-migrations.mjs --staged`
   refuses a commit that stages `src/db/**` without BOTH a new `.sql` and a journal change.
4. Expand → migrate → contract: additive first; no destructive statement in the same release as the code
   that stops using the column.
5. `pnpm db:status` shows the file pending; run the migration only with explicit approval, then re-run
   `db:status` and show the output (VERIFIED, not expected).

## Runner facts (`apps/web/scripts/apply-sql-migrations.mjs`)
- Replaces `drizzle-kit migrate` (which silently no-ops on journal drift). Reads numeric-prefixed SQL files in
  lexical order from `drizzle/`, tracks applied tags in `_manual_migrations`, one transaction per file.
- Flags: `--status`, `--dry-run`, `--prod` (pulls Vercel env into `.env.prod.tmp`, deletes after), `--env=`,
  `--mark-applied` (+ `--yes`) for adopting the runner on an existing DB.
- The runner reads the DIRECTORY, not the journal — the journal is for drizzle-kit + the husky gate. Historical
  drift exists (journal stops early for some files); do not "fix" it in an unrelated commit.

## Query rules
- Access through the shared `db` helpers; parameterised queries only (Drizzle `sql` template), never string
  concatenation of user input.
- Profile-scoped data (`watch_history`, `track_plays`, prefs) is keyed by profile, not user — keep it that way.
- Two device tables exist: `devices` (urls, token, tunnel) and `companion_devices` (FK target of `video_files`),
  bridged by `machine_id = devices.id`. Renderer/cast URLs use `devices.lan_url`, never the tunnel.
- `packages/db` has no own tsconfig; it is typechecked through `apps/web`.

## Gotchas
- `pnpm install --frozen-lockfile` reporting "Already up to date" while `Cannot find module 'postgres'` →
  hollow pnpm store entry; `pnpm add --ignore-workspace postgres@<locked>`.
- `react-hooks/purity`: no `Date.now()` in server-component render — compute `now()` in SQL.
- Drizzle Studio (`pnpm db:studio`) also opens PROD unless `--env` is redirected.

## Verify
- `pnpm -C apps/web db:status` output pasted (applied/pending) before AND after any migration.
- `pnpm -C apps/web typecheck`; tests touching the schema in `pnpm -C apps/web test`.
- `git --no-pager diff --stat -- apps/web/drizzle apps/web/src/db` shows `.sql` + `_journal.json` + schema together.
