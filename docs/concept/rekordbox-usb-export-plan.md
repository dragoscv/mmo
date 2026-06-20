# Rekordbox USB Export — Findings & Implementation Plan

> Status: **active build**. Supersedes `docs/concept/rekordbox-pdb.md` (the earlier
> "don't ship a pdb writer" spike). Decision reversed: we are shipping a writer.

## Why the old recommendation changed
The previous spike avoided a binary writer for legal/maintenance reasons and
relied on "XML + manual rekordbox import". The user requires **true
plug-and-play USB** that works standalone on CDJ/XDJ hardware with **no
rekordbox re-import**. That mandates writing Pioneer's on-device database +
analysis files ourselves.

## Verified format (from a real rekordbox-exported reference USB, `F:`)
```
F:\Contents\<Artist>\<Album>\<file>            # audio, organized by tags
F:\PIONEER\rekordbox\export.pdb     (167 KB)   # classic Device Library — UNENCRYPTED DeviceSQL
F:\PIONEER\rekordbox\exportExt.pdb  (73 KB)    # extension tables (cues/colors) — UNENCRYPTED DeviceSQL
F:\PIONEER\rekordbox\exportLibrary.db (118 KB) # OneLibrary — SQLCipher ENCRYPTED (key not public)
F:\PIONEER\USBANLZ\Pxxx\<hex>\ANLZ0000.DAT     # per-track analysis, magic 'PMAI'
                              \ANLZ0000.EXT     # extended analysis (color waveform, etc.)
F:\PIONEER\MYSETTING*.DAT, DEVSETTING.DAT, CDP\, DeviceLibBackup\
```
- `export.pdb` / `exportExt.pdb` headers begin `00 00 00 00 00 10 00 00` → page
  size 4096, the DeviceSQL/"pdb" format documented by Deep-Symmetry
  (`crate-digger`, `rekordbox_pdb.ksy`) and `rekordcrate`.
- `exportLibrary.db` first bytes are random → SQLCipher. **Not generatable**
  without Pioneer's obfuscated key. Treated as a research spike only.

## Compatibility matrix (target)
| Gear | Reads | Our support |
|------|-------|-------------|
| CDJ-2000NXS2, CDJ-3000, XDJ-1000/RX/XZ, XDJ-700 | classic `export.pdb` + ANLZ | ✅ phase 1–2 |
| OPUS-QUAD, CDJ-3000X, XDJ-AZ | Device Library Plus / OneLibrary (also classic) | ✅ via `exportExt.pdb` + classic fallback |
| Older CDJ-2000/900 | classic `export.pdb`, FAT32 only | ✅ (warn on exFAT) |

## Decisions (from Q&A)
- **Hybrid**: ship binary writer; keep XML export as fallback.
- **Rust sidecar** in the companion (spawned like the analyzer), using
  `rekordcrate` structs where possible + our own writer for the gaps.
- **Full analysis**: beatgrid + waveform + hot/memory cues. v1 cues =
  auto memory cue at first beat/track start; full cue editor later.
- **export.pdb + exportExt.pdb + ANLZ**; OneLibrary = best-effort spike.
- **Audio**: validate; auto-transcode only incompatible files → AAC 320k
  (`.m4a`); copy compatible files untouched; never modify the source library.
- **Filesystem**: detect FAT32/exFAT and warn; never auto-format.
- **Playlists**: mirror MMO playlists (with folders) + optional auto
  By Genre / By BPM / By Key smart folders.
- **Verify**: automated round-trip (write → parse back with our reader →
  diff vs the `F:` reference) + user hardware tests.

## Architecture
```
apps/web (UI)
  └─ action: exportRekordboxUsb(scope, destination, options)
        └─ POST /library/usb/export-rekordbox  (companion, SSE progress)
              ├─ resolve tracks (+ DSP analysis: bpm, beatgrid, key, waveform)
              ├─ spawn Rust sidecar `rbexport`  (stdin JSON manifest → writes USB)
              │     ├─ writes Contents/<Artist>/<Album>/<file> (or transcoded)
              │     ├─ writes PIONEER/USBANLZ/**/ANLZ0000.DAT + .EXT
              │     ├─ writes PIONEER/rekordbox/export.pdb
              │     └─ writes PIONEER/rekordbox/exportExt.pdb
              └─ stream progress lines back as SSE
```
Rust sidecar lives at `server/native/rbexport/` (Cargo crate), built to a
binary the companion spawns (mirrors the python analyzer spawn pattern).

## Phases (build-all, then hardware test — per user)
1. **Scaffold + audio layout**: Rust crate, JSON manifest contract, write
   `Contents/` tree + filesystem/transcode handling.
2. **export.pdb writer**: tables — tracks, artists, albums, genres, keys,
   colors, labels, playlists, playlist entries, artwork. Round-trip vs reader.
3. **ANLZ writer**: `.DAT` (path, beatgrid, memory/hot cues, mono waveform
   preview) + `.EXT` (color waveform, extended cues). Wire DSP beatgrid.
4. **exportExt.pdb** (Device Library Plus extension tables).
5. **Transcode (ffmpeg) + FS detect/warn + playlist folders + auto crates.**
6. **Round-trip diff harness** vs `F:` reference; fix field-by-field.
7. **OneLibrary spike** (encrypted — research only). **DONE/closed**: not
  feasible and not needed; see "OneLibrary / Device Library Plus spike" below.

## Risks
- Byte-exact DeviceSQL pages (row groups, offset bitmaps, page chaining) are
  fiddly; the `F:` reference + our reader make this tractable.
- ANLZ tags must match player expectations (PCOB/PCO2 cues, PQTZ beatgrid,
  PWAV/PWV2/PWV3/PWV4/PWV5 waveforms).
- OneLibrary key likely not obtainable → that gear path relies on classic
  fallback (acceptable; confirmed those players read classic).

## OneLibrary / Device Library Plus spike (phase 7 — research only)

> Status: **closed — not implemented (infeasible + unnecessary).** Verdict:
> do not attempt to write `exportLibrary.db`. The classic `export.pdb` +
> `exportExt.pdb` + ANLZ files we already generate are sufficient for
> standalone playback on every current AlphaTheta player, including the
> OneLibrary-era gear (OPUS-QUAD, CDJ-3000X, XDJ-AZ).

### What `exportLibrary.db` is
`PIONEER/rekordbox/exportLibrary.db` is the **OneLibrary** (formerly "Device
Library Plus") database, added to export media by rekordbox 6.8.1+. It is a
SQLite database **encrypted with SQLCipher 4** (AES-256-CBC + HMAC-SHA512,
PBKDF2 key derivation). It is a *second* database that sits next to the
classic Device Library — players that understand it still also read the
classic `export.pdb`.

### Evidence it is encrypted (measured on the `F:` reference USB)
- File size: 118 784 bytes (29 × 4096-byte pages).
- No `SQLite format 3\0` magic. First 16 bytes are random:
  `88 19 99 b9 97 c2 07 ba b8 14 0a 42 6a 0d 95 dc` — this is the SQLCipher
  per-database **salt** (used in PBKDF2), exactly as SQLCipher lays out a
  raw-keyed db.
- Shannon entropy of the whole file = **7.9985 bits/byte** (≈ the 8.0 ceiling),
  i.e. statistically indistinguishable from random → fully encrypted, no
  plaintext headers or page structure leaking.

### Why the key is not obtainable (or usable)
- The OneLibrary key is **different from the `master.db` key** and is **not
  published**. Unlike the desktop `master.db` key (which the community
  recovered and tools like `pyrekordbox` ship), the OneLibrary key has not
  been extracted/published in a reusable form.
- It *could* in principle be lifted from the rekordbox desktop binary (it must
  decrypt its own export), but:
  1. **Legal/DMCA**: extracting and redistributing AlphaTheta's obfuscated
     key to defeat an access-control measure is exactly the kind of
     circumvention we are avoiding. Even if a third party publishes it, baking
     it into MMO would tie a shipped product to a circumvention secret that
     AlphaTheta rotates at will.
  2. **Fragility**: the key/obfuscation is rotated across rekordbox versions;
     any value we hardcode would silently break and produce media that newer
     firmware might reject.
  3. **Schema**: even with the key, the internal OneLibrary schema is
     undocumented and would need its own byte-exact reverse-engineering effort
     on top of the two pdb writers — months of work for zero playback benefit.

### Why we don't need it
- OneLibrary is widely understood to be primarily a **DRM / ecosystem-lock**
  layer, not a playback requirement. AlphaTheta players that read OneLibrary
  fall back to the classic `export.pdb` + ANLZ when OneLibrary is absent —
  which is precisely the standalone, no-re-import path the user asked for.
- Our matrix already covers OPUS-QUAD / CDJ-3000X / XDJ-AZ via the classic +
  `exportExt.pdb` route.

### What we ship instead
- We **do not** write `exportLibrary.db`. We intentionally omit it; players
  treat the media as a classic Device Library export and play it standalone.
- If a future firmware ever *requires* OneLibrary (none does today), the only
  compliant options would be (a) drive an installed rekordbox via its own
  export (out of scope, defeats "no rekordbox") or (b) an official
  AlphaTheta SDK (does not exist). Both are revisited only if hardware
  testing surfaces a player that refuses classic media — not expected.

### Decision
**Closed. No code.** This section documents the dead-end so we don't
re-investigate. The sidecar deliberately produces a classic + Device Library
Plus (`exportExt.pdb`) export with no OneLibrary file.
