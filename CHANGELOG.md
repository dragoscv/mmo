# Changelog

All notable changes to **MMO — Multi Media Organizer** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Web app and companion are versioned independently:
> - **Web app** (`app/`): see [`app/package.json`](app/package.json) — currently `0.2.0`
> - **MMO Companion** (`server/`): see [`server/package.json`](server/package.json) — currently `0.3.7`, releases at [github.com/dragoscv/mmo/releases](https://github.com/dragoscv/mmo/releases)

---

## [Unreleased]

## [v0.9.5]

### Added
- **Chromaprint `fpcalc` now bundled with the installer** (companion v0.9.5): the ~3.3 MB `fpcalc.exe` binary ships under `resources/fpcalc/win-x64/` and the python sidecar auto-discovers it on first fingerprint call by setting the `FPCALC` env var. Users no longer need to install Chromaprint separately or edit PATH — fingerprinting works out of the box on a fresh install. The dev tree (`pnpm dev`) also resolves the same binary from `server/assets/fpcalc/<arch>/`. Mac and Linux paths are scaffolded (`mac-x64`, `linux-x64`) but binaries are not yet shipped for those platforms; users can still set `FPCALC` manually or install via brew/apt.

## [v0.9.4]

### Fixed
- **Fingerprint sub-jobs silently "succeeding" with no data** (companion v0.9.4): if `fpcalc` (Chromaprint) is missing from PATH, the python sidecar caught the import/exec error, stuffed `_fingerprint_error` into the result, and returned `ok=true` with no `acoustidFingerprint`. The companion marked the job `done`, the library row was never updated, and the bulk-analyze skip filter (`!t.acoustidFingerprint`) re-enqueued the same broken job on every subsequent batch — producing the spam `Persist: track <id> (fingerprint) returned no fields` in the analyzer log. Same bug existed for DSP and stems primary fields.
  - Python `handle_analyze` now sanity-gates the result: if a requested category produced no primary field (`bpm` for DSP, `acoustidFingerprint` for fingerprint, `stems` for stems), the sub-job fails with the underlying error message instead of returning ok. Users now see actionable errors like `fingerprint: fpcalc not found on PATH` in the analyzer log, the job lands in the error lane, and the failing track stops being re-enqueued every batch.

## [v0.9.3]

### Fixed
- **Analyzer results not surviving companion restart** (companion v0.9.3): closing the companion mid-batch forced a full re-analysis on next launch, even though hundreds of tracks had already been processed. Two root causes:
  1. **Persistence wired in the wrong place.** The `analyzer.on("complete")` listener that folds results back into `tracks` lived inside `createLibraryRouter()` (`routes.ts`). It was attached when the route was mounted, not when the analyzer started — and the analyzer's `rehydrate()` microtask schedules itself in the constructor, so a fresh-start with queued jobs from a prior session could fire `complete` before the listener was wired. Moved persistence into the `Analyzer` constructor itself (in `analyzer.ts`); listener now attaches synchronously, before any rehydrate microtask can run.
  2. **`dspAnalyzedAt` falsely set on fingerprint-only or stems-only runs.** The old code stamped `dspAnalyzedAt = now()` whenever ANY field was written. So a fingerprint sub-job (which only writes `acoustidFingerprint`) was leaving `dspAnalyzedAt` populated — making the bulk-analyze skip filter believe DSP was done. Per-category gating: `dspAnalyzedAt` is now stamped only when actual DSP fields (`bpm` / `key` / `loudness` / `beats`) land in the row.
- **WAL durability on shutdown**: `closeLibraryDb()` now runs an explicit `PRAGMA wal_checkpoint(TRUNCATE)` before closing the SQLite handle. Belt-and-braces on top of `better-sqlite3.close()`'s built-in checkpoint, so a forced kill between the pragma and `close()` still leaves the main DB file fully up to date.
- **Visibility into persistence**: every successful tracks-row write now logs `Persisted track <id> → dsp+stems+fp` to the analyzer log; failures log explicit warnings (`track not found`, `returned no fields`) instead of being swallowed by a silent `try/catch`.
- **Stems WAL checkpoint after each completion**: the long, multi-minute stems job triggers a `wal_checkpoint(PASSIVE)` immediately after writing — so even if the user yanks the power right after a stems sub-job finishes, the result is already in the main DB file (not just the WAL).

### Why this matters
Before this fix, a typical workflow looked like: start analyzing 8 607 tracks → close companion after 2 hours (~600 tracks done) → reopen → web app shows zero analyzed tracks → user starts the batch again from scratch. Now: every completed sub-job commits its bpm/key/loudness/stems/fingerprint to the library DB on the same tick the analyzer emits "complete", so closing the companion at any moment preserves all completed work and the next batch correctly skips already-done categories per-track.

## [v0.9.2]

### Fixed
- **Batch progress counter stuck at 32 / N during big batches** (companion v0.9.2): the in-memory `completed` ring buffer caps at 128 entries to keep the status payload small, but during a 17 000-job batch with fingerprint sub-jobs finishing in 32 ms each, the buffer was being evicted faster than the UI polled it (1.2 s cadence). The UI counted `completed.length`, so it stopped growing past the visible 32-entry slice. Now `GET /analyze/status?since=<ms>` returns authoritative `{done, errored, total}` counts queried directly from sqlite, and the UI passes `batch.startedAt` as `since` on every poll. Counter now climbs accurately into the thousands.
- **Per-track per-category skip in bulk analysis** (web 0.2.1): `startBulkDspAnalysis` now narrows the requested options per-track based on what's already in the DB — a track with DSP done but missing stems will only enqueue the stems sub-job. Previously every track got 1–3 sub-jobs regardless, so the fingerprint queue was full of 32 ms jobs re-fingerprinting already-fingerprinted tracks. Returns `{enqueued, skipped, tracksTouched}` so the UI reports "Enqueued 17 209 jobs across 8 607 tracks — skipped 4 121 already complete". A new "Re-analyze already-done categories" toggle bypasses the skip when needed.
- **UI shows category badge on every queue/completed entry** so users can tell at-a-glance which lane each sub-job belongs to (DSP/Stems/FP).
- **Batch counter sums progress across all running lanes**, not just the most-progressed one. Previously a 3-lane setup at 50/30/70 % would only credit 70 %.
- **Redundant CURRENT JOB card hidden** when lanes are present (it duplicated the per-lane mini-bar in LanesPanel).

## [v0.9.1]

### Fixed
- **Stems progress bar over-detected passes (showed 4/4 then 5/5…) and effectively doubled wall-clock time** (companion v0.9.1): `audio-separator` defaults `demucs_params.shifts=2`, which means htdemucs_ft runs **8 tqdm bars** (4 models × 2 shifts), not 4. Our pass detector hard-coded `expected_passes=4`, so as soon as the 5th bar started we recomputed pct as `(4+0)/5 = 0.80` — the bar visibly jumped backwards from ~94% to ~80% and the user perceived it as a restart. Worse, shifts=2 doubles GPU compute for ~0.05 dB SDR improvement (negligible for DJ stems use).
  - Forced `demucs_params.shifts=1` → htdemucs_ft now runs exactly **4 passes** (one per model in the bag), matching `expected_passes` and cutting stems wall-clock roughly in half (RTX 3060 Ti: ~10 min/track → ~5 min/track).
  - Stems progress is now **strictly monotonic** — even if our pass-count estimate had to grow mid-run, the bar can never reverse. A backwards bar reads as "stalled" or "restarted" to the user and was previously tripping the watchdog's stall detection.
  - Set `mdx_params.batch_size=4` and `mdxc_params.batch_size=4` so MDX-NET / Roformer models actually saturate the GPU instead of running one segment at a time.

## [v0.9.0]

### Added
- **Multi-worker concurrent analyzer with persistent queues** (companion v0.9.0):
  - The analyzer is now split into **three independent worker lanes** that run truly concurrently because they use disjoint resources:
    - **DSP** (~30 s/track) — CPU + RAM. BPM, key, energy, loudness, beats, chord progression.
    - **Stems** (~5 min/track) — GPU + VRAM (or CPU). Source separation via audio-separator.
    - **Fingerprint** (~3 s/track) — CPU. Chromaprint via `fpcalc`.
  - Each lane owns its own Python sidecar, FIFO queue, pause flag, and stall watchdog. Calling `enqueue(trackId, path, {dsp,stems,fingerprint})` now splits the request into 1–3 sub-jobs that share a `requestId` and route to their respective lanes. For an 8 600-track library this means full BPM/key/loudness data lands in the DB **~10× faster** than waiting for stems to drain (which is hard-capped by GPU throughput).
  - **SQLite-backed persistence** in the existing library DB (`analyzer_jobs` table). Every enqueue, state transition, and completion writes through to disk so a companion crash, OS restart, or power loss **resumes exactly where it left off**. Jobs marked `running` at startup are demoted to `queued` so they re-execute from scratch.
  - **Per-lane pause / resume**. Pause stops pulling new work but the currently-running sub-job continues to completion (killing it would just waste partial work). Use this to free the GPU for other apps while DSP + Fingerprint keep churning.
  - **Dedicated control sidecar** for one-shot commands (plugin scan/describe/render, health checks, GPU install). Previously these had to wait for the analyze queue to drain — sometimes 5+ minutes behind a stems job. Now they run on a separate process and respond immediately.

### Changed
- **`POST /analyze/queue/clear`** now accepts body `{ category?: "dsp"|"stems"|"fingerprint"|"all" }`. Default behaviour is unchanged (`all`).
- **`GET /analyze/status`** response is backwards-compatible (still has `current`, `queue`, `completed`) and adds:
  - `lanes: LaneStatus[]` — per-lane snapshot with `paused`, `current`, `queue`, `queueDepth`.
  - `paused: boolean` — true when every lane is paused.
  - `anyPaused: boolean` — true when at least one lane is paused.
- **`AnalyzerJob`** now carries `requestId` and `category` so the UI can group sub-jobs from the same request and colour-code by lane.
- The Analysis page now shows a **three-card "Worker lanes" panel** above the legacy queue/current views, with per-lane pause/resume/clear buttons and live progress mini-bars.

### Added — HTTP API
- `POST /analyze/pause` body `{ category?: Category|"all" }` → pause one or all lanes.
- `POST /analyze/resume` body `{ category?: Category|"all" }` → resume.

### Migration notes
- The companion auto-creates the `analyzer_jobs` table on first launch — no manual migration step. If you had jobs in flight when upgrading, they're discarded (the v0.8.x analyzer kept queue state purely in memory).
- Existing UI code calling `analyzer.status()` keeps working; the new `lanes` field is opt-in.

## [v0.8.8]

### Fixed
- **Stems progress bar appeared to restart 3 times near completion with `htdemucs_ft`** (companion v0.8.8): the fine-tuned Demucs model is an *ensemble of 4 checkpoints* — audio-separator runs them sequentially and emits a fresh tqdm bar (0→N) for each. The v0.8.6 stderr-tap mapped every bar to the same 60→95 % slice, so each pass looked like a job restart. Now we detect tqdm resets, count passes, and divide the stems range across N passes (e.g. for htdemucs_ft: pass 1 = 60–68.5 %, pass 2 = 68.5–77 %, pass 3 = 77–85.5 %, pass 4 = 85.5–94 %). Progress is now monotonic across the entire stems block, with `[pass 2/4]` shown in the message for ensemble models.
- **Stems message now includes model + ensemble count** at start: `Separating with htdemucs_ft (4-model ensemble)` so the user knows up-front why it'll take a while.
- **"Writing stem files…" event** at 95 % after `sep.separate()` returns, so the bar visibly closes the gap between the last tqdm chunk and the start of the canonical-rename loop.

## [v0.8.7]

### Added
- **GPU acceleration for stems separation** (companion v0.8.7):
  - Sidecar now probes for NVIDIA hardware (`nvidia-smi`), ONNX runtime providers, and PyTorch CUDA at every `ping`. The result (`gpu` field on `/analyze/health`) tells the UI exactly what's installed and what's missing.
  - New analysis-page panel: "GPU acceleration" with model name, CUDA driver version, ONNX provider list, torch.cuda status, and a one-click **Install onnx-gpu** / **Install torch-CUDA** / **Install all** button. Pip-installs into the same Python that the sidecar is running, then automatically restarts the sidecar so the new providers register.
  - Surfaces a clear next step when the user has hardware but missing pieces: install onnxruntime-gpu (we do this for them) or install the CUDA Toolkit + cuDNN runtime DLLs (we link to NVIDIA's downloads).
  - Sidecar logs `[stems] GPU acceleration ACTIVE: NVIDIA GeForce RTX 4090 (onnx=onnxruntime-gpu, providers=['CUDAExecutionProvider', ...])` at first stems load so it's obvious from the live log too.
  - New HTTP endpoints: `POST /analyze/gpu/install { target: "onnx"|"torch"|"all" }` and `POST /analyze/restart { force: bool }`.
  - Expected speedup: 5–15× on stems separation with htdemucs_ft / Roformer / MDX models on a modern NVIDIA card.

### Changed
- **Analyzer stall watchdog raised from 2 min to 3 min**: stems on slow CPUs with htdemucs_ft can have long gaps between tqdm flushes during model warm-up. With v0.8.6's tqdm progress wrap it should never matter, but 3 min gives more headroom for first-time GPU init.

## [v0.8.6]

### Added
- **Stems separation now reports per-chunk progress with ETA** (companion v0.8.6): audio-separator drives ONNX/torch inference through tqdm, which writes progress bars directly to stderr (bypassing the logging module). Previously the UI sat at "Loading model…" → "done" with no signal during the heavy chunked inference (which is most of the wall-clock time on CPU). Now we tap stderr, parse tqdm's `N/M [elapsed<eta, it/s]` format, and emit `[stems] 73% — Separating 432/591 (02:14, ETA 00:48)` every 1 s or 0.5 %, whichever comes first. Net: continuous progress + accurate ETA across the whole 60 → 95 % stems block.

### Fixed
- **Chord-progression stall ("Chords: HPSS…" stuck for 2+ min)** (companion v0.8.5): the chord block ran a second `librosa.effects.harmonic(y)` over the FULL track — a 60–120 s blocking call on long files that always tripped the watchdog. Removed entirely. CENS chromagrams (Müller & Ewert 2011) are designed to be transient/percussion-robust on their own, so we now feed the raw signal directly. Net: chord progression goes from 60–180 s on a 6 min track to ~3–6 s.

### Performance
- **Cap analysis to first 8 minutes** (`librosa.load(duration=480)`): plenty for stable BPM/key/loudness/chords on any DJ-relevant track, bounds analysis time on long DJ mixes/sets in the user's library.
- **True-peak oversampling now conditional**: only run the 4× polyphase FIR when the sample peak exceeds -1 dBFS. For mastered/quiet content the sample peak is reported directly (worst-case error < 0.5 dB, below any limiter's working threshold). Saves 8–20 s per long stereo track.
- **Combined effect**: a typical 5–7 min DJ track that previously took 3–5+ minutes for the DSP block now finishes in ~30–60 s. Stems separation (audio-separator) remains the dominant cost when enabled.

## [v0.8.4]

### Fixed
- **DSP key estimation stuck at 27%** The watchdog from 0.8.3 caught it eventually, but the underlying work was just genuinely slow.
  - Compute the key on a **90-second middle window** instead of the full track — tonal centre is stable across a song, so this preserves accuracy and is ~6× faster.
  - Use `chroma_stft` (FFT-based, ~10× faster than `chroma_cqt`) for the Krumhansl correlation — CQT's extra precision doesn't change the winning key for triad templates.
  - Drop HPSS `margin=4.0` to default `margin=1.0` (avoids the wide-kernel median pass).
  - Lower chord-progression hop length 512 → 2048 (4× fewer frames to template-match).
  - Emit fine-grained progress events inside the key + chord blocks (`Key: HPSS…`, `Key: chromagram…`, `Key: profile correlation…`, `Chords: HPSS…`, etc.) so the watchdog sees activity and the user knows what's happening.
- **Stall watchdog tightened**: 5 min → 2 min, check every 15 s (was 30 s). Now that every sub-stage emits a progress event, 2 minutes of silence is unambiguously a hang.

## [v0.8.3]

### Fixed
- **Stuck-at-5% DSP analysis**
  - Python: `_dsp_analyze` now accepts a `progress` callback and emits an event before each major sub-stage (loudness, decode, beat tracking, key estimation, energy, chord progression). Granular timeline visible in the live log.
  - Companion: new **stall watchdog** (5 minutes of zero progress → abort + respawn). Without it, a single corrupt audio file that locks `librosa.load` could silently freeze the queue for the entire session.
  - Watchdog logs the kill reason (`watchdog: stalled Ns without progress (last stage: dsp)`) so it's obvious which track + stage triggered the abort.

## [v0.8.2]

### Fixed
- **Mid-job SIGTERM crash + companion-offline flapping**: the analyzer's `health()` probe used to send a `ping` to the Python sidecar even while it was busy doing inference. Because stdin is processed sequentially, the ping queued behind a 30–60 s stems separation, hit the 20 s timeout, and the failure path **killed the busy worker mid-job** — surfacing as `python exited (SIGTERM)` and flipping the UI "Companion offline" indicator every couple of minutes.
  - Fix: when a job is in flight, skip the probe entirely and synthesize a healthy response from cached deps (the sidecar is provably alive — it's emitting progress events).
  - Fix: `fail()` no longer kills the worker unconditionally; it only kills when there's no active job.
  - Diagnostics: every kill site now records a `killReason` (`health: ping timeout`, `user cancel (track N)`, `shutdown`) so the post-mortem `Python sidecar exited` log line names the actual culprit instead of just `code=null sig=SIGTERM`. `failCurrentJob()` and `cancel()` now write to the analyzer log feed so the `/analysis` page shows them in real time.
- **Companion HTTP keep-alive tuned** (companion v0.8.2): `keepAliveTimeout=65 s`, `headersTimeout=70 s`, `requestTimeout=0`. Node's 5 s default was occasionally tearing down sockets between the web app's 1–3 s polls under event-loop pressure, contributing to the flapping online indicator.

## [v0.8.1]

### Added
  - Per-row hover actions on Queue (× remove) and Recently Completed (↻ retry, 🗑 remove).
  - Card-level bulk actions: **Clear** queue, **Retry failed (N)**, **Clear done**, **Clear** completed.
  - New companion routes: `POST /analyze/retry/:id`, `POST /analyze/queue/clear`, `DELETE /analyze/completed/:id`, `POST /analyze/completed/clear?filter=`, `POST /analyze/retry-failed`.
  - Retry re-enqueues with the **original** path + options so transient crashes (e.g. `python exited (SIGTERM)`) recover with one click; refuses to re-enqueue if the source file no longer exists.
- Two layout fixes (CSS-only, no rebuild needed): `/analysis` and `/plugins` now scroll inside `<main>`'s height-capped area so content is no longer hidden behind the bottom Now-Playing bar.
- **Audio plugin host** (companion v0.8.0): VST3 / AU / LV2 hosting via Spotify's `pedalboard` (built on JUCE). The companion's existing Python sidecar gained `plugins.scan` / `plugins.describe` / `plugins.render` opcodes — no second process.
  - New `/plugins/*` HTTP API on the companion (scan, describe, offline render, status, range-aware audio streaming).
  - Web app gained a dedicated **Plugins** workspace at `/plugins` (browse, search, filter VST3 / AU / LV2, inspect parameters, manage scan roots) plus a **Plugins** sidebar entry.
  - Reusable `<PluginRack/>` widget integrated into the **DAW** (per-track inserts), **Sound Editor** (FX sidebar), and **Live** page (master FX widget — explicit user request).
  - Inventory cached at `<userData>/plugins.json`; renders streamed from `<userData>/plugin-renders/*.wav` with HTTP-range support.
  - Realtime plugin processing (Mixer / Live monitor) intentionally deferred to a future release — latency over HTTP is too high. WebAudio remains the realtime path; plugins handle the offline lane (track render, recording post-FX, selection FX).
- Comprehensive documentation rewrite covering full MMO suite (web app + companion + extension + infra)
- Bilingual README (RO primary + EN mirror)
- New `docs/arhitectura/`, `docs/aplicatie/`, `docs/companion/`, `docs/extension/` sections
- Negative-cache + single warn for `/api/companion/download` GitHub failures

### Changed
- Default `COMPANION_REPO_NAME` updated from `rekordbox-mwrty` to `mmo` (now public at [github.com/dragoscv/mmo](https://github.com/dragoscv/mmo))
- `README.md` and `NAVIGARE.md` rewritten as suite-level (legacy versions archived under `docs/legacy-*.md` and `concept/legacy-*.md`)
- `concept/README.md` and `concept/arhitectura.md` reframed for the umbrella suite
- Companion bumped 0.7.10 → **0.8.0** (minor bump for the new plugin-host feature surface).

### Deprecated
- Single-app framing in legacy `concept/legacy-app-readme.md` and `concept/legacy-arhitectura.md`

---

## Companion releases

See [github.com/dragoscv/mmo/releases](https://github.com/dragoscv/mmo/releases) for the full list. Recent:

- **v0.3.4** — Latest at time of writing (May 2026)
- v0.3.3, v0.3.2, v0.3.1, v0.3.0 — earlier patches

---

## Web app

The web app does not yet publish discrete releases; it is deployed continuously from `main`. Tagged web app releases will be added here once the cut-over to a versioned deployment pipeline is complete.

---

[Unreleased]: https://github.com/dragoscv/mmo/compare/main...HEAD
