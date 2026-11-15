# Crate and cue sync — the server side (phase 1)

Implementation notes for phase 1 of [`crate-sync-design.md`](crate-sync-design.md): the MMO Server as the hub.
The design document is the source of truth for the rules; this page records what was built, how it was
verified, and what is deliberately still open.

Status: **built 2026-11-15** (server `3.17.0`). No app consumes it yet — the Decks desktop is phase 2
(`WP19-58` follow-ups) and the Compose / Swift apps are phase 4.

## What is on the server now

| Piece | Where | Notes |
|---|---|---|
| `quick_hash` column + index | `tracks` (`library/schema.ts`, `library/db.ts`) | 32 hex chars; computed at scan and ingest, backfilled for older rows |
| Quick hash | `library/quick-hash.ts` | Must stay byte-identical to `crates/decks-library/src/util.rs#quick_hash` |
| Backfill | `library/quick-hash-backfill.ts`, `POST /library/quick-hash/backfill` | Idempotent; named SQL parameters |
| Cue points | `track_cues` | One row per cue; a loop is ONE row with `start_ms` + `end_ms` |
| Beat grids | `track_grids` | One hand-edited grid per track (`fixed` = the DJ locked it) |
| Revision + tombstones | `library_sync_meta`, `library_tombstones` | One counter per user; tombstones kept 180 days |
| Hash aliases | `track_hash_aliases` | Old hash of a re-tagged file, so other devices still match |
| Conflict rules | `library/sync-changes.ts` | `applyChanges` — the table in §5 of the design |
| Change feed | `GET` / `POST /library/changes` | Rows with `rev > since` plus tombstones; `reset` when the cursor is too old |
| Favourite | `PUT /library/tracks/{id}/favorite` | Idempotent; the `POST` toggle stays for old clients |
| Crate entries | `playlist_tracks.entry_id` / `sort_key` / `rev` | Reported per entry on add / remove / reorder |
| Hub event | `{"type":"library:changed","rev":…}` on `/ws` | `createLibraryRouter`'s `onChanged` |
| Cloud relay | `library/cloud-feed.ts` → `cuepoints` | Loop end travels as ONE cloud row (`end_ms`) |
| Cloud apply | `packages/db/src/sync-apply.ts` | `applyCuepointUpsert` now persists `endMs` |
| Cloud migration | `apps/web/drizzle/0032_cuepoints_end_ms.sql` | **Run on production 2026-11-15** (owner-approved), after a backup |

### Track identity

`quick_hash` = the first 16 bytes of SHA-256 over the file size (u64 little-endian) ‖ the first 256 KiB ‖ the
last 256 KiB when the file is larger than 512 KiB — the same definition the Decks apps store as `file_hash`.
A server-side track is resolved from an explicit numeric id, the quick hash (current or an alias), or the
whole-file `sha256` the cloud keys by.

### Conflict resolution

Per row, last-write-wins on the **device clock** the change carries (`changed_at`, ms since epoch), with the
device id as the tie-break when the times are equal. The revision is only the feed cursor, never the conflict
key, because an offline edit arrives with its own time. A missing clock becomes the server's now; a time in the
future is cut to now.

The per-entity rules (section 5 of the design) are implemented and tested:

- different cues of one track → both kept; the same cue → the later wins;
- two cues in one hot slot → the later keeps the slot, the earlier becomes a **memory cue labelled with its
  slot** (`Hot 4` for slot 3, or its own label when it had one);
- delete vs edit → the later wins, a tombstone records the delete;
- a crate is renamed / moved as a row; entries carry their own order key, so an add on the phone and a reorder
  on the laptop both survive (no room between two keys → the crate is re-keyed evenly);
- a deleted crate goes to a **30-day trash** (soft delete + tombstone); an entry added with a *newer* clock
  brings it back and clears the tombstone, an entry whose clock is older loses;
- a grid is one object: the later grid wins as a whole;
- a cue or entry for a track (or crate) the server does not have answers `unknown` — it is not dropped, it
  simply waits for a later batch once the row exists.

### Sizes and limits

2 000 changes per push, 5 000 rows per page, 180-day tombstone retention, 128-char entity id, 1 MB body limit.

## How it was verified

- **Route tests on a real SQLite file** — `server/src/library/library-changes.test.ts`, 25 tests, one per
  conflict-table row plus the crate ordering and the hub announcement. They start the real Express router over
  a temporary `library.db`, not a mock.
- **Quick hash** — `server/src/library/quick-hash.test.ts`, 9 tests pinning the byte stream against an
  independent construction (size encoding, both chunk boundaries, first-chunk vs tail).
- **The relay's payload is what the cloud applies** — the server test asserts the queued payload
  (`trackSha256`, `positionMs`, `endMs`, `kind`, `label`); `apps/web/src/lib/sync-apply.test.ts` feeds exactly
  that shape into the cloud's `applyCuepointUpsert` and asserts the row is inserted / updated with its end.
- **Backfill on real libraries**, measured on 2026-11-15:

  | Library | Tracks | Files present | Time | Per track | Failures | Second pass |
  |---|---|---|---|---|---|---|
  | `mixai-companion-headless` (the local dev server) | 11 | 11 | 1 017 ms | 92 ms | 0 | 0 rows |
  | `mmo-companion` (external volume, 318 GB) | 17 214 | 17 214 | 449 993 ms | 26 ms | 0 | 0 rows |

  Both runs went through the companion's own bootstrap first, which added `quick_hash` and the five new tables
  to a real pre-existing database (72 columns). Coverage after the run: all rows; every hash well-formed; a
  stored hash compared equal to a fresh `quickHash()` call on the same file.
  The per-file cost is the storage, not the code: the music lives on an external volume where a single 256 KiB
  first-chunk read measured ~50 ms cold.
- **`openapi:check`** reports 275 routes in code / 275 in the spec and a matching `info.version`;
  **`openapi:lint`** reports no errors (9 pre-existing warnings elsewhere). Kotlin `Models.kt`, Swift
  `Models.swift` and the TypeScript SDK types were regenerated and committed.
- **Server suite**: 39 files / 371 tests green, including the 34 new ones.

## What was NOT tested

- **The cloud migration was run on production on 2026-11-15** with the owner's go-ahead: `cuepoints` was backed
  up first (schema, indexes, constraints and the data — the table held 0 rows), then `end_ms` was added and the
  migration recorded in `_manual_migrations`, in one transaction. Verified afterwards: the column exists and is
  nullable, the tracker row is present, the row count and the unique index are unchanged, and no migration is
  pending. The migration rolled out ahead of any writer, which is the safe order (the column waits unused until
  an app relays a cue).
- **No cloud round trip through a live Postgres.** The apply path is tested with the cloud's own unit-test
  harness (a stubbed Drizzle client), not against a real database.
- **No app end to end.** Nothing reads `/library/changes` yet; the first real client is phase 2/4.
- **The re-link flow (D2)** is only half here: the server can resolve a track by an old hash alias, but nothing
  yet popsulates the alias when a file's content changes, and the "offer a re-link when exactly one track
  matches" prompt is client-side work (phase 2/4).
- **Crate folders and the crate tree** (`parent_external_id`, `is_folder`, `sort_key` on the crate row) are
  stored and served but no route creates a folder yet; the Compose clients do the tree (phase 4).
- **Order-key growth**: keys are fixed-width decimals, so a crate would need ~10^12 inserts at one spot before a
  rebalance; the threshold from the design (40 characters) is therefore never reached in practice, but the
  rebalance path is only unit-tested, not exercised live.
- **Clock skew**: a device with a badly wrong clock can win or lose unfairly. Accepted in the design; the loser
  is kept where it matters.

## Running the backfill yourself

```powershell
# one pass over every track that has no hash yet (safe to re-run)
Invoke-RestMethod -Method Post http://localhost:17899/library/quick-hash/backfill `
    -Headers @{ 'x-device-token' = $token; 'x-user-id' = $userId } `
    -ContentType 'application/json' -Body '{}'
```

The answer is `{scanned, updated, failed, elapsedMs, remaining}`. `failed` counts files that could not be read
(moved, deleted, permissions) — those rows keep `quick_hash` NULL and are retried on the next call.
