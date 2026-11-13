# Crate, favourite and cue sync through the MMO Server: design proposal (WP19-28)

Status: **decided by the owner on 2026-11-13** (section 9 records the answers). Nothing in this document is built yet.
Scope chosen by the owner on 2026-11-12: full two-way sync, cue points included.

The facts in section 1 were read from the code on 2026-11-12 (a read-only survey, nothing was run). Where this
document and the code disagree, the code is right and this document needs a fix.

## 1. What exists today

| Piece | Where | What it has | What it lacks |
|---|---|---|---|
| Decks desktop (Tauri) | `apps/mixai` | Reads the library from the MMO Server over HTTP (`src-tauri/src/companion.rs`); a track is the server's numeric id; favourite toggle through the server | No local library. Hot cues, cue loops and beatgrid edits live in engine memory only: a reload or a new load of the same track loses them. No crates |
| Decks Android, Decks desktop (Compose), Decks iOS / macOS | `apps/decks-android`, `apps/decks-desktop`, `apps/ios/DecksApp` through `decks-ffi` | Local SQLite library (`crates/decks-library`, schema v3): tracks with a UUID, `path_key`, `file_hash`; cues in seconds (hot / memory / loop, index, end, colour, label); beatgrids; crates with folders; history; snapshots and the protect lock | No revision, no "changed at", no tombstones: cues and crate contents are deleted and rewritten as a whole. No server client at all (no pairing, no token) |
| MMO Server | `server/src/library` (`library.db`) | Tracks per user (`UNIQUE(user_id, filepath)`), `is_favorite`, rating, tags, `sha256` (whole file, written only after an analysis pass), `field_versions`; playlists with `external_id` and `updated_at`; playlist tracks by position | No cue table. No quick content hash. Favourite is a toggle (a retry flips it back). Adding, removing and reordering playlist tracks is not reported to the change feed |
| Server to cloud feed | `server/src/sync`, `packages/db` | Changes (`tracks`, `playlists`, `playlist_tracks`, `tags`, `cuepoints`) pushed to `mixai.ro/api/sync`, pulled every 30 s, last writer wins per field; the cloud has a `cuepoints` table (integer milliseconds, a loop is two rows, unique per track + external id) and keys tracks by whole-file SHA-256 | On the server, applying a remote cue point does nothing. The log is cleaned after 30 days. The module header still calls itself a scaffold |
| Media feed (video) | `server/src/media/library.ts` | The pattern this design reuses: a revision per row, a tombstone table, `list(since)` that answers everything when the cursor is unusable | Video only |
| MixAI Music (Android, iOS) | `apps/music-android`, `apps/ios` | Plays the server's music library | No star control (tracker WP17-86) |
| Web | `apps/web` | Favourite button (reads the cloud, writes through the server) | Nothing for cues |

Two statements in the earlier tracker note were wrong and are corrected here: the server's `sha256` column IS
filled (after analysis, so not for every track), and decks-library is used by the iOS / macOS app too, not only
by the Compose apps.

### Units of a cue position today

| Store | Unit | Loop |
|---|---|---|
| decks-library | seconds (float) | one row with start and end |
| Decks desktop engine | frames of the source file; cue loops as a length in beats | in memory |
| Cloud | integer milliseconds | two rows (in, out) |
| rekordbox XML | seconds, 3 decimals | start + end |
| Serato, Traktor | milliseconds | start + length / end |

## 2. Goals and non-goals

Goals:

1. A hot cue, memory cue, loop or cue loop set on one Decks device appears on the DJ's other Decks devices.
2. A track starred in MixAI Music (phone) shows up in Decks, in a "Starred" crate.
3. Crates (name, folder, tracks, order) are the same on every Decks device of the DJ.
4. Nothing a DJ made is lost silently: a conflict keeps both sides in some form, and a destructive incoming
   change is preceded by a library snapshot.
5. Every app keeps working with the server unreachable (a club without the home network) and catches up later.

Non-goals of this work package: sharing crates between users, syncing the audio files themselves, syncing
history / play counts, analysis results (key, energy) and stems, importing other apps' libraries (WP19-38 did
that), real-time collaboration on one crate (the Yjs relay stays unused here).

## 3. Proposed decisions

Each decision names the recommended option first. The questions for the owner are in section 9.

### D1. The MMO Server is the hub

Decks apps sync with the DJ's MMO Server; the server's existing feed carries the changes on to the cloud.
A Decks app never talks to the cloud directly in this work package.

- Why: ADR-0010 makes the server "the brain"; the desktop app already depends on it; the server is reachable
  on the LAN and through Tailscale; one hub means one conflict rule.
- Cost: a DJ without an MMO Server gets no sync (as today). The Compose and Swift apps need pairing first.
- Alternative: cloud as the hub. It would work away from home, but every Decks app would need an account
  sign-in and the cloud would have to hold cue data for files it has never seen. Can be added later as a
  second transport over the same change format.

### D2. A track is identified by a quick content hash, stored on both sides

`quick_hash` = the first 16 bytes (32 hex characters) of SHA-256 over: the file size as a little-endian
64-bit number, the first 256 KiB of the file, and the last 256 KiB when the file is larger than 512 KiB. This
is what decks-library already stores as `file_hash` (`crates/decks-library/src/util.rs`). The server gets a new
column `quick_hash`, computed when a track is scanned or ingested (two short reads, no decode), so every track
has it at once.

- Why: the whole-file SHA-256 exists only after analysis and costs a full read; paths differ per device; the
  server's numeric id is local to one server; ISRC / AcoustID are often missing.
- The desktop app does not need the hash for its own cues: it addresses a track by the server's id. The hash
  is what lets the same file on a phone or a laptop find the same cues.
- Known limit: rewriting tags in place changes the hash (both hashes do). Rule: a track whose hash is unknown
  to the server keeps its sync data locally and is offered a re-link when exactly one server track has the
  same duration (within 0.5 s) and the same normalised title + artist; more than one candidate = no automatic
  link. The old hash stays as an alias of the server track so other devices still match.
- The cloud keeps its SHA-256 key; the server maps between the two when it relays.

### D3. Cue positions travel as integer milliseconds from the start of the decoded audio

- Why: it is what the cloud table, Serato, Traktor and (to 3 decimals) rekordbox use; half a millisecond of
  rounding is below what a DJ can hear or beat-match; a round trip is stable after the first conversion.
- "Decoded audio" means the Decks decoder (symphonia). `docs/decks/beatgrid.md` describes the cases where
  another decoder starts an MP3 one frame earlier or later; a client with another decoder (the web player)
  applies the documented offset or does not show cues.
- A loop is ONE cue with a start and an end (the Decks model). The relay to the cloud splits it into the two
  rows the cloud has today until the cloud table gets an end column.
- A cue loop of the desktop engine (a length in beats on a hot cue) is stored as a loop with start and end in
  milliseconds; the desktop converts with the track's grid when it loads.

### D4. One cue = one row with its own id; conflicts are resolved per cue, and a losing hot cue is kept

- Every cue has a UUID made by the device that created it, a "changed at" time and the device that changed it.
- Two devices that edit DIFFERENT cues of a track offline: both edits survive.
- The same cue edited on two devices: the later change wins (per cue, not per track).
- Two devices put different cues in the SAME hot cue slot: the later one takes the slot; the earlier one is
  kept as a memory cue labelled with its old slot. Nothing is dropped.
- A delete is a tombstone with a time: it wins over an older edit, a newer edit brings the cue back.
- Times: the server stamps changes that arrive while online; a change made offline carries the device's
  time; a time in the future is cut to the server's now. Equal times are ordered by device id.

### D5. Crates are the server's playlists with per-entry ids and order keys

- A crate maps to a server playlist (`type = 'crate'`, plus parent and folder flag for the crate tree).
- Each crate entry gets its own id and an order key (a short text key that sorts between its neighbours), so
  adding a track on the phone and reordering on the laptop both survive. Today both sides rewrite the whole
  list by position, which can only be "last full list wins".
- decks-library keeps its current API (`set_crate_tracks` with a whole list) and turns the difference between
  the old and the new list into per-entry changes inside the crate (schema v4).
- Deleting a crate deletes it everywhere, after a snapshot on each device that applies the delete.

### D6. Favourites: a real "set" call, and a "Starred" crate in Decks

- New `PUT /library/tracks/{id}/favorite` with the wanted value (safe to retry); the toggle stays for old
  clients. The OpenSubsonic `star` / `unstar` calls already behave this way.
- Decks shows the favourites as a built-in crate "Starred" (the desktop app's Favourites filter already reads
  the server's flag). Starring in Decks writes the same flag.
- MixAI Music gets the star button (WP17-86).

### D7. Change feed: a revision per row and tombstones, pulled with a cursor; one push call

On the server, per user:

- every syncable row (favourite flag, playlist, playlist entry, cue, grid) carries `rev`, a number from one
  counter that grows with every change;
- deleted rows leave a tombstone with its `rev`;
- `GET /library/changes?since=<rev>` answers the rows with a larger `rev`, the tombstones, and the new cursor;
  a cursor older than the oldest kept tombstone (kept 180 days) answers `reset: true` and the full state;
- `POST /library/changes` takes a batch of client changes (each with its id, its "changed at" and its device)
  and answers, per change, applied or superseded, plus the new cursor;
- the hub WebSocket sends "library changed" with the new `rev`, so an open Decks app pulls at once; without
  the socket a client pulls at start, every 60 s and 2 s after a local change.

Why state with revisions and not the existing change log: a device that was away for three months needs the
current state, and the cloud feed's log is cleaned after 30 days (it would force a full resync exactly for the
devices that need the feed most). The existing server to cloud feed stays as it is and is fed from the same
writes, so there is one place where a change is recorded, not two.

Size limits (same style as the playlist routes): at most 2 000 changes per push, 5 000 rows per pull page,
the 1 MB body limit stays. Demo servers refuse the push (read-only), as they do for every write.

### D8. Sync is per user, not per profile

Favourites and playlists are per user on the server today; profiles (adult / kids) exist only in the media
module. A DJ's cues and crates belong to the account.

### D9. Safety on every device

- Before a pull that deletes a crate or more than 20 cues or entries, a Decks app with a local library takes a
  snapshot (the existing library-safety mechanism), at most one per sync round.
- While the library is protected (protect lock on), incoming changes wait and the app says "sync paused:
  library protected"; local changes are still sent.
- The first sync of a device that already has cues or crates is a MERGE, never a replace: rows are matched by
  content (same track, same kind, same position within 10 ms = the same cue; a crate with the same name in the
  same folder = the same crate), everything else is added on both sides. A preview with counts is shown before
  the first sync runs.
- Gig lock (WP19-60): while it is on, incoming changes are held like the cloud profile sync.

## 4. Data model (sketch)

Server (`library.db`), new or changed:

```sql
ALTER TABLE tracks ADD COLUMN quick_hash TEXT;            -- 32 hex, index (user_id, quick_hash)
CREATE TABLE track_hash_aliases (user_id TEXT, quick_hash TEXT, track_id INTEGER, PRIMARY KEY (user_id, quick_hash));
ALTER TABLE tracks ADD COLUMN sync_rev INTEGER NOT NULL DEFAULT 0;   -- bumped when the favourite flag changes

CREATE TABLE track_cues (
  id TEXT PRIMARY KEY,               -- UUID from the creating device
  user_id TEXT NOT NULL, track_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- hot | memory | loop
  slot INTEGER,                      -- 0..7 for hot cues, NULL otherwise
  start_ms INTEGER NOT NULL, end_ms INTEGER,
  colour TEXT, label TEXT,
  changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL,
  rev INTEGER NOT NULL
);
CREATE TABLE track_grids (           -- only if the owner includes grids (question 3)
  user_id TEXT NOT NULL, track_id INTEGER NOT NULL,
  bpm REAL NOT NULL, first_beat_ms INTEGER NOT NULL, markers TEXT, fixed INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL, rev INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
-- playlists: + parent_external_id, is_folder, sort_key, rev
-- playlist_tracks: + entry_id (UUID), sort_key, changed_at, changed_by, rev
CREATE TABLE library_tombstones (user_id TEXT, entity TEXT, entity_id TEXT, rev INTEGER, changed_at INTEGER,
  PRIMARY KEY (user_id, entity, entity_id));
CREATE TABLE library_sync_meta (user_id TEXT PRIMARY KEY, rev INTEGER NOT NULL);
```

decks-library (schema v4): `cues` gets `uuid`, `changed_at`, `changed_by`, `dirty`; `crate_tracks` gets
`entry_id`, `sort_key`, `changed_at`, `dirty` (the primary key moves from position to entry id; the position
is derived from the order key); `crates` gets `uuid`, `changed_at`, `dirty`; a `sync_tombstones` table; a
`sync_state` row (server id, cursor, last sync). The sync logic is a pure module (`sync.rs`): it produces the
pending changes as JSON and applies a pulled batch; the platform code (OkHttp, URLSession) only moves bytes.
That keeps networking and TLS out of the Rust core and makes the merge rules unit-testable.

Decks desktop: no local database. On a track load it reads the track's cues (and grid) from the server and
applies them to the engine; a cue set, moved or cleared is written to the server with a short debounce; a
small local cache keyed by the server id covers a server that is slow to answer. This alone fixes "hot cues
are gone after a reload".

Contract chain: every new route goes through `server/openapi.yaml`, `openapi:check`, `openapi:gen`
(Kotlin `Models.kt`, Swift `Models.swift`, the TypeScript SDK).

## 5. Conflict rules in one table

| Case | Result |
|---|---|
| Different cues of one track changed on two devices | Both kept |
| The same cue changed on two devices | Later change wins |
| Two cues claim one hot cue slot | Later one gets the slot, the other becomes a memory cue labelled with the slot |
| Cue deleted on A, edited later on B | The edit wins, the cue is back |
| Cue edited on A, deleted later on B | Deleted |
| Track added to a crate on A, crate reordered on B | Both: the new entry sits where its order key puts it |
| The same entry moved on A and on B | Later move wins |
| Crate renamed on A and on B | Later name wins |
| Crate deleted on A, track added on B | The later of the two wins; a delete is applied after a snapshot. A deleted crate goes to a 30-day trash and can be restored from any device (owner, 2026-11-13) |
| Favourite set on A, cleared on B | Later change wins |
| Grid changed on A and on B | Later grid wins as a whole (a grid is one object) |
| A track's file is not known to the server | Its data stays local and waits; it is re-linked by the rule in D2 |

## 6. Phases

Each phase is shippable by itself and has its own checks. Effort: S about a day, M a few days, L one to two
weeks of agent work with reviews.

| Phase | Content | Effort | Done means |
|---|---|---|---|
| 1 | Server: `quick_hash` at scan / ingest + backfill job, cue table + grid table, favourite `PUT`, revisions + tombstones, `GET / POST /library/changes`, hub event, OpenAPI + generated models, playlist-entry changes reported, plus the cloud relay of cues (owner: phase 1, so the cloud `cuepoints` table gains an end column and a loop is one row) with its production migration run only on the owner's explicit go-ahead | M to L | Route tests on a real SQLite file incl. the conflict table above; a backfill run on the dev server's library with timings; the relay proved against the cloud's apply path; `openapi:check` green |
| 2 | Decks desktop: cues, cue loops (and grid edits) kept on the server per track, loaded with the track; "Starred" already works | S to M | Set cues on one dev instance, reload: still there; second instance loads the same track: same cues; server off: the app still plays and catches up after |
| 3 | MixAI Music: star button on Android and iOS (WP17-86) | S | Star on the phone, the track is in the desktop Favourites within 5 s |
| 4 | Compose + Swift Decks: pairing with the server, decks-library schema v4, the pure sync module, first-sync merge with preview, crates and cues both ways, "Starred" crate | L | Two devices + the server: the conflict table as an automated test over the pure module, then live on two real devices; snapshots taken before destructive pulls; protect lock holds incoming changes |
| 5 | Desktop crates panel (the desktop has no crates today); the cloud relay moved into phase 1, so this phase keeps only the panel and the "Starred" view on the desktop | M | Separate decisions when phase 4 is done |

## 7. Risks and open points

- Tag editors change the content hash; the re-link rule in D2 is the mitigation and needs real-library testing.
- The server's user id comes from a header that is not bound to the device token (anyone holding the token
  can name any user). Sync does not make this worse, but phase 1 should bind the user to the paired device
  for the new routes.
- Clock skew between devices decides "later". The server stamps what it can; offline edits on a device with a
  wrong clock can win or lose unfairly. Accepted for cues and crates (the loser is kept where it matters, D4).
- decks-library schema v4 is a migration of a user's library: it runs behind the existing "snapshot before a
  schema change" and needs a down-path test (restore of the snapshot on the old schema).
- The cloud relay decided for phase 1 changes a production table (`cuepoints`): the migration is prepared and
  reviewed with the rest, but it is RUN only when the owner says so, with a backup first (the Deploy/DB rules of
  this repo). Until then the relay writes to the server only.
- The Compose and Swift apps cannot be compiled on the build PC used for Decks desktop; phase 4 needs the Mac
  build VM and Android devices.
- Order keys can grow after many inserts at one spot; the server rewrites a crate's keys when one passes
  40 characters (one change per entry, same revision).

## 8. What was looked at and rejected

- **Last full list wins for crates** (no per-entry ids): simplest, but a phone "add to crate" would be undone
  by any reorder on the laptop that started earlier.
- **Reusing the server to cloud change log as the device feed**: one format, but the 30-day cleanup breaks
  devices that were away, and the log has no per-device cursor on the server side.
- **CRDT (Yjs) per crate**: solves ordering well, but adds a document store, a relay and a second data model
  for a single-user problem.
- **Whole-file SHA-256 as the key**: already the cloud's key, but it needs a full read of every file on every
  device (minutes on a phone with a large library) and exists on the server only after analysis.

## 9. Decisions (owner, 2026-11-13)

Asked with the document open; the recommended option was taken everywhere except the last one.

| # | Question | Decision |
|---|---|---|
| 1 | Hub | **The MMO Server** is the hub; the cloud feed stays what it is |
| 2 | Track identity | **Quick content hash** on both sides, with a re-link offered and confirmed when a hash changes (a re-tag, another format) |
| 3 | Scope of "cue points" | **Hot cues, memory cues, loops, cue loops AND hand-edited beatgrids** (analysis results are not synced) |
| 4 | Two devices, one hot cue slot | **The loser becomes a memory cue** labelled with its old slot |
| 5 | Deleting a crate | **30-day trash on the server**, restorable from any device, still snapshotting before a delete is applied |
| 6 | Order of the phases | **Desktop first** (cue persistence), then the phone star (WP17-86), then Compose / Swift |
| 7 | First sync of a device with data | **Merge with a preview** before anything is written |
| 8 | Cues in the cloud | **In phase 1** (not phase 5): the relay goes in with the server work, so the cloud `cuepoints` table gains an end column (a loop is one row). The production migration on that table is run only with the owner's explicit go-ahead, separately |

What these change in the document: phase 1 is larger (the cloud relay and its table change move into it) and phase 5
keeps only the desktop crates panel; the crate delete is a trash rather than a hard delete; grids are in scope, so
the grid table in section 4 is not optional; and the first sync of section 5 ("merge") is a preview the DJ confirms.
