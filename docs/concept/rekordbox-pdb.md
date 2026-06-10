# Spike: Direct write to Rekordbox `export.pdb`

> **Status**: research-only (no production code shipped). One-batch spike to inform whether MMO should ship a Rekordbox-binary writer or stay on XML+manual-import.
>
> Owner: dragoscv. Target review window: before v1.0 USB export work.

## TL;DR — recommendation

**Don't ship a PDB writer in MMO.** Stick with the existing XML export path
plus a "drag this folder into Rekordbox once" manual step. The legal,
maintenance, and data-corruption risks of a binary writer outweigh the UX
gain over a one-time manual import. Revisit only if Pioneer/AlphaTheta
publishes an official spec or stable API (they have not, as of this spike).

If a writer is ever attempted, use [Deep-Symmetry's `crate-digger`][cd]
(JVM) as the reference reader and adopt the [Kaitai struct][ks] schema
they maintain ([rekordbox_pdb.ksy][ksy]) instead of hand-rolling a parser.

## What is `export.pdb`?

`PIONEER/rekordbox/export.pdb` is the Pioneer-proprietary binary database
that ships on a USB drive prepared by Rekordbox 5/6/7. It's what CDJ-2000,
CDJ-3000, XDJ-1000, XDJ-RX, and the OPUS-QUAD load when you insert the
stick. Without a valid `.pdb`, the player falls back to "USB has no
Rekordbox library" and shows a flat folder browse only — no playlists,
no waveforms, no cue points, no key/BPM grid.

Closely related on-disk artefacts (also undocumented):

- `export.pdb` — the master database (this spike's focus)
- `PIONEER/USBANLZ/<hash>/ANLZxxxx.DAT` / `.EXT` / `.2EX` — per-track
    analysis (waveforms, beat grid, hot cues, memory cues). Separate
    binary spec, also reverse-engineered by Deep-Symmetry.
- `PIONEER/rekordbox/share.PDB` — Rekordbox 6+ multi-export staging file.

## Format crash course

The file is a paged store, default page size **4 096 bytes** (declared
in the header so larger pages are legal). The header (first page) holds:

| Offset | Size | Field                                       |
| ------ | ---- | ------------------------------------------- |
| 0x00   | 4    | `0x00000000` (always, treated as magic)     |
| 0x04   | 4    | Page size in bytes (LE)                     |
| 0x08   | 4    | Number of tables (LE)                       |
| 0x0C   | 4    | "Next unused page" pointer                  |
| 0x10   | 4    | "Next chunk" or sequence                    |
| 0x14   | 4    | Reserved (zero)                             |
| 0x18   | …    | Array of `numTables` table pointers (16 B)  |

Then comes a series of typed pages (one per "table"). Known table types
include (incomplete list — Deep-Symmetry's docs have the full set):

| ID | Table             | Notes                                                |
| -- | ----------------- | ---------------------------------------------------- |
| 0  | Tracks            | The core row — title, BPM, key id, artist id, …      |
| 1  | Genres            | id → name                                            |
| 2  | Artists           | id → name                                            |
| 3  | Albums            | id → name + artist_id                                |
| 4  | Labels            | id → name                                            |
| 5  | Keys              | id → musical key (camelot-ish)                       |
| 6  | Colors            | id → name                                            |
| 7  | Playlist tree     | folders & playlists, parent_id pointer for nesting   |
| 8  | Playlist entries  | playlist_id × track_id × sort_order                  |
| 9  | History playlists | the on-CDJ history list                              |
| 10 | History entries   | rows above                                           |
| 11 | Artwork           | jpeg path → id                                       |
| 12 | Columns           | UI column visibility                                 |
| 13 | Categories        | "My Tag" categories                                  |
| 14 | Tags              | "My Tags" entries                                    |
| 15 | Tag tracks        | tag_id × track_id                                    |
| 16 | Sort order data   | per-column sort caches                               |
| 17 | Hot cue banks     | colour palette assignments                           |
| 18 | History meta      |                                                      |
| 19 | Recommend like    |                                                      |
| 20 | Stack columns     |                                                      |

Within each table, rows live on data pages. A row consists of:

1. A 16-bit row checksum (custom polynomial, not CRC-16/CCITT).
2. A 16-bit index within the page.
3. The fixed-length scalar fields (track id, artist id, BPM × 100, …).
4. A trailing block of variable-length string offsets, then the strings
   themselves. Strings come in three forms: short ASCII (length-prefix +
   chars), long ASCII (different length encoding), and long UTF-16LE.
   Pickling the *right* form for a given character set is the most
   error-prone step — get it wrong and the CDJ silently truncates the
   row or drops the whole page.

A full read/write reference would require many pages of structs. The
authoritative source is the Kaitai schema below — print it once, it's
~1 200 lines including comments.

## References (read these before writing a single byte)

- [Deep-Symmetry / DJ-tracker reverse-engineering hub][djl] — landing page.
- [`crate-digger`][cd] — JVM reader, Apache 2.0. Battle-tested over
    several years on player firmware up to mid-2024.
- [`rekordbox_pdb.ksy`][ksy] — the Kaitai struct schema. Generates
    parsers in Java/Python/Ruby/Go/JS/C++/Lua/etc. Keep in mind it's a
    *reader* — the `.ksy` doesn't auto-generate writers, only parsers.
- [Pioneer DJ Forum thread (archived)][pf] — original community findings.
- [`pyrekordbox`][pyrk] — Python, MIT, has experimental write support
    for the SQLite-based Rekordbox 6/7 *desktop* DB (not export.pdb).

[cd]: https://github.com/Deep-Symmetry/crate-digger
[ks]: https://kaitai.io/
[ksy]: https://github.com/Deep-Symmetry/crate-digger/blob/main/src/main/kaitai/rekordbox_pdb.ksy
[djl]: https://djl-analysis.deepsymmetry.org/
[pf]: https://groups.google.com/g/dvscompiler/c/exJfqIM-MUE
[pyrk]: https://github.com/dylanljones/pyrekordbox

## Risk register

### Legal

- Pioneer DJ / AlphaTheta owns the format. There is no published spec
    and no permissive licence on file structure documentation. Producing
    a writer is closer to a clean-room reimplementation than reading it.
- Trademarks "Pioneer", "Pioneer DJ", "rekordbox", "CDJ", "XDJ", "OPUS"
    are registered. We can refer to interoperability ("MMO works with
    Pioneer DJ players") under nominative fair use, but cannot ship the
    word "Rekordbox" as a product feature name without a disclaimer.
- The `crate-digger` project is read-only and explicitly avoids shipping
    a writer for legal-risk reasons. We should weigh the same trade-off.

### Format drift

- Pioneer ships firmware updates that have, in the past, added new
    table IDs and changed string-pickling rules without notice. A writer
    that assumed table-id 14 = "Tags" would silently corrupt USBs after
    a player firmware bump.
- The format is undocumented; what we know is reverse-engineered from
    sample files. Edge cases (very long titles, exotic Unicode, deeply
    nested playlists, > 50 000 tracks) are under-tested.

### Data corruption

- A bad checksum on one row poisons that page; the player may skip the
    whole page or, worse, re-write it. Users who lose a `.pdb` lose
    their playlists, hot cues, beat grid, and play history.
- Recovery is hard: there's no `.pdb-fsck`. Users would have to re-run
    Rekordbox export from scratch.
- We'd need an integrity test rig with at least one CDJ-3000 (~€2 200)
    or XDJ-RX3 (~€1 700) to validate writes empirically.

### Maintenance

- Pioneer's release cadence ≈ 2 major firmware revisions/year. Each
    one is a regression risk for our writer.
- Diff'ing two `.pdb` files requires a custom dump tool.

## What a writer would have to do (sketch)

```text
build(tracks, playlists, …) -> Buffer:
    1. allocate header page (4096 B)
    2. for each table:
        a. emit table-header page (page type, row count, …)
        b. emit data pages with rows + offset table at end of each page
        c. compute and write 16-bit row checksum
    3. write index pages back-pointing to data pages
    4. patch header with table pointers and "next free page"
    5. write footer (fixed length, mostly zeroes + magic)
```

Hardest sub-tasks (each is its own multi-day spike):

- The exact 16-bit checksum polynomial. `crate-digger` validates it on
    read but the table layout makes it equivalent to a custom CRC.
- String pickling: when does the player accept ASCII-short vs ASCII-long
    vs UTF-16-long? Get this wrong and the row "exists" for `crate-digger`
    but doesn't render on the CDJ.
- Page balancing: when a row exceeds the remaining space in a page, the
    real Rekordbox writer splits it across pages with a continuation
    pointer. Replicating this is non-trivial.
- Index pages (the "find row N in table T" lookup) need to point to the
    correct page + offset.

## The four alternative paths (and why each loses to "do nothing")

| Path                                     | Effort  | UX   | Risk     | Verdict        |
| ---------------------------------------- | ------- | ---- | -------- | -------------- |
| **A**: Direct `.pdb` writer              | months  | best | high     | not worth it   |
| **B**: XML export + manual RB import     | done    | ok   | none     | **status quo** |
| **C**: Drive Rekordbox 6 desktop SQLite  | weeks   | ok   | medium   | revisit at v2  |
| **D**: Wait for Pioneer's official API   | n/a     | best | none     | not arriving   |

`pyrekordbox` proves path C is feasible for the *desktop* Rekordbox 6
SQLite database (`master.db`, encrypted with SQLCipher key derived from
machine fingerprint). That gets us into Rekordbox without a manual
import — but still requires the user to then run Rekordbox's own export
to USB. Net UX win is one click, not "no clicks".

## Recommended decision

1. **Hold the writer spike here.** No production code in MMO yet.
2. **Document the XML→manual-import path more prominently** in the user
    onboarding so users don't expect direct USB writes.
3. **If we ever revisit**, start with path C (`pyrekordbox`-style SQLCipher
    talk to the desktop Rekordbox), not path A (binary writer).
4. **Park this doc under `concept/`** so the next person who asks "why
    don't we just write to .pdb?" finds the answer in 30 seconds.

## Hands-on artefacts shipped with this spike

- This document.
- A code-level spike header at `server/src/library/rekordbox-pdb.ts`
    that reads the page-size + table-count from a real `.pdb` file and
    documents (in TypeScript, so the types are checked) what a one-track
    writer would have to allocate. **Reader-only**, no writer.
- A unit test at `server/src/library/rekordbox-pdb.test.ts` that
    exercises the reader against a hand-built fixture so we know the
    header parser is correct.
