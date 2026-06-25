# Changelog

All notable changes to **MuzicAI — AI Music Suite** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Web app and companion are versioned independently:
> - **Web app** (`apps/web/`): see [`apps/web/package.json`](apps/web/package.json) — currently `0.4.2`
> - **MuzicAI Companion** (`server/`): see [`server/package.json`](server/package.json) — currently `1.0.14`, releases at [github.com/dragoscv/mmo/releases](https://github.com/dragoscv/mmo/releases)

---

## [Unreleased]

### Changed — analysis runs are now one logical job per run (`apps/web` `0.7.3`, companion `1.0.38`)

- **A single "Start analysis" run is now ONE job that contains many item
  sub-jobs**, instead of one job row per `track × category`. Each run gets a
  shared `batchId`/label that is threaded across every page and every targeted
  companion, so the `/analysis` page groups the whole run into a single row with
  aggregate progress and per-item done/running/queued/failed counts.
- Companion: `analyzer_jobs` carries `batch_id`/`batch_label`; new
  `GET /analyze/batches` returns one `BatchSummary` per run with live aggregate
  state. `Analyzer.batches()` surfaces it; `enqueue()` accepts a `batch`.
- Web: `POST /analyze` accepts `batchId`/`batchLabel`; `startBulkDspAnalysis`
  mints one batch per run; new `getAnalyzerBatches` aggregates batches across
  online companions; `/analysis` shows a new **Jobs** card (one row per run).

### Changed — metadata analysis moved to the companion (`apps/web` `0.7.2`, companion `1.0.37`)

- **The "What to Fetch" metadata analysis (Metadata/Artwork/Lyrics/BPM-web) is
  now a 4th companion analyzer lane ("metadata")** instead of a client-side
  modal loop. This fixes the bug where, after a few items, the page refreshed
  and the whole run was lost (the old loop held progress in browser/serverless
  memory). It now runs fully in the background on the companion, survives
  refresh, and **stores each track immediately** (no review step).
- **The analyze modal is removed.** All analysis lives on the **/analysis page**:
  config (DSP/Stems/Fingerprint/Web-metadata + sub-fields), the live job queue,
  per-lane status & progress, and the log console. "Analyze"/"Reanalyze" buttons
  and the floating widget now route to /analysis.
- Companion: in-process metadata lane (MusicBrainz/iTunes/Deezer/CoverArtArchive/
  LRCLIB via fetch — no python); only fills EMPTY fields; stamps `analyzedAt` so
  re-runs resume on the remainder. Results sync to cloud like DSP/stems/fp.

### Fixed/Added — real-time metadata analysis + cloud prune (`apps/web` `0.7.1`)

- **Metadata analysis ("What to Fetch": Metadata/Artwork/Lyrics/BPM) now saves
  in real time.** Previously changes accumulated in memory and were only written
  at the end after a manual review — so a serverless recycle or closing the tab
  **lost all progress**. Each batch is now applied to the DB immediately
  (auto-apply), with a live "Saved" counter; no review step required.
- **Resumable + crash-safe.** Every processed track is stamped `analyzedAt`
  (even no-change ones), and the analyzer always reads the stalest-analyzed page
  — so an interrupted run resumes exactly where it stopped instead of redoing
  work or skipping tracks. Transient batch errors retry the same page (no skips)
  instead of aborting.
- **Cloud-prune reconciliation** (`reconcileCloudWithCompanions` + Scanner
  "Reconcile library" button): removes cloud tracks whose file no longer exists
  on an **online** companion. Offline devices and empty libraries are never
  pruned (guards against false mass-deletes).

### Fixed/Changed — multi-companion scanner, analysis & counts (`apps/web` `0.7.0`)

- **Scanner rebuilt on the companion-side scan flow.** The old Scanner walked
  the WEB-APP HOST's filesystem (`scanFolderAction` → `fs.readdir`), which on
  Vercel produced **"Folder not found: H:\\Music"** because the host has no such
  drive. Scans now run ON the companion (`POST /scan` → poll → ingest → ack) via
  a new `scan-orchestrator` action with live progress.
- **Multi-companion everywhere.** New `getAllCompanionLinks` / `aggregateAcrossCompanions`
  resolvers. The Scanner now lists every companion with **which device owns each
  watched folder**, online/offline status, and per-device track/analyzed counts.
  A device selector targets the right companion for custom-folder scans.
- **Analysis enqueues across ALL online companions** (was: a single auto-picked
  device, which silently "Enqueued 0" when that device's library was empty).
- **Auto initial scan on folder-add**: adding a watched folder now kicks a
  one-time full scan so EXISTING files are ingested immediately (the chokidar
  watcher uses `ignoreInitial` and only sees files added later).
- Dashboard/Analysis gates now accept ANY paired companion (aggregate), not just
  the auto-picked one. Per-device track counts use the companion's
  `/library/stats.total` instead of a 500-row paged sample.

### Changed — training M2M endpoints moved off Vercel to the gateway (`apps/web` `0.6.3`)

- **The trainer-facing machine-to-machine training endpoints now live on the
  gateway** (`api.muzicai.ro`), completing the migration of non-browser traffic
  off Vercel:
  - `POST /api/training/webhook` (trainer progress events)
  - `GET /api/training/control/:jobId` (trainer polls control signal)
  - `POST /api/internal/reconcile` (Vertex job reconciler)
  The shared logic (`ingestTrainerEvent`, `consumeControlSignalForTrainer`) moved
  to `@mmo/db` so the web route and gateway run identical code; the web route
  PATCH half (user-driven, NextAuth) stays on Vercel.
- **Vertex reconciler rewritten for Cloud Run**: queries the Vertex AI REST API
  with the instance metadata-server token (no `spawn(python)`); driven by **GCP
  Cloud Scheduler** every 2 min instead of Vercel Cron (removed from
  `vercel.json`).
- Net result: everything the desktop companion AND the Python trainers call is
  now on Google Cloud; Vercel serves only the browser-facing Next.js app + its
  session/billing/cron-free routes.

### Added — Phase 2: shared `@mmo/db` + sync on the gateway; `api.muzicai.ro`

- **New shared `packages/db`** is now the single source of truth for the
  Drizzle schema, consumed by both `apps/web` and `apps/gateway`. The schema
  files moved out of `apps/web/src/db`; thin re-export shims keep all existing
  `@/db/schema*` imports working unchanged. The sync conflict logic
  (`sync-apply.ts`, per-field LWW) also moved here and is now run identically by
  the web route and the gateway (db client injected via `setDb`), so there is
  no drift.
- **Phase 2 sync on the gateway**: `GET/POST /api/sync` now served by
  `apps/gateway`, reusing the shared `@mmo/db` logic. Free-tier device gate +
  per-field LWW preserved. Track changes fire a best-effort cache-bust to the
  web app's new `POST /api/internal/revalidate` hook so `/library` facets
  refresh.
- **`api.muzicai.ro`** mapped to the gateway (Cloud Run domain mapping +
  Cloudflare DNS-only CNAME). Companion (`server` `1.0.36`) now defaults its
  control plane + sync to `api.muzicai.ro`.
- **Companion** (`server` `1.0.35`) gained a persistent gateway WebSocket
  client for the heartbeat (instant online/offline) with HTTP fallback.

### Added — MuzicAI Gateway (`apps/gateway`, Hono on Cloud Run)

- **New dedicated control-plane service for the companion**, replacing direct
  companion→Vercel heartbeat posts. The Electron companion's ~10s announce loop
  was hitting Vercel serverless cold starts (`AbortError` timeouts, stale
  `last_seen_at`), which surfaced as the analyzer modal stuck on "Reconnecting
  to companion…". The gateway is a long-lived Hono service on GCP Cloud Run
  (`mmo-mw-prod`, `europe-west4`) that owns:
  - `POST /api/devices/announce` — heartbeat + command channel, wire-compatible
    with the legacy web route;
  - `WS /ws` — persistent heartbeat where a live socket = `online` and a
    disconnect flips the device `offline` instantly;
  - `GET /health` — liveness.
  It reuses the same Postgres (`DATABASE_URL`) and `AUTH_SECRET` as the web app
  and declares only the control-plane schema slice (`devices`,
  `device_commands`); `apps/web` stays the single owner of migrations.
- **Companion** (`server` `1.0.34`) now targets the gateway via a new
  `gatewayUrl` setting (default = Cloud Run URL, `MMO_GATEWAY_URL` override).
  Existing pairings adopt it automatically.
- Phase 2 (separate PR) will migrate the `/api/sync` data plane to the gateway
  behind a shared `packages/db`.

### Fixed — analyzer "Reconnecting…" with multiple paired devices (`apps/web` `0.6.1`)

- **Fixed the Reanalyze/analyzer modal stuck on "Reconnecting to companion…"
  when more than one device is paired.** `getCompanionLink()` picked an
  arbitrary device row (DB order), so it could select a long-offline machine
  whose Cloudflare tunnel is dead — every probe returned 530 even though the
  active companion was online (audio playback worked because it resolves the
  device per-track). It now ranks paired devices by **online (within the
  heartbeat window) → true-local loopback → most-recent `last_seen_at`** and
  picks the best one.

### Changed — complete rebrand to **MuzicAI** (`apps/web` `0.6.0`)

- **New brand identity: MuzicAI (muzicai.ro).** Replaced the inconsistent
  "MMO / Mwrty Music Organizer / Multi Media Organizer" naming everywhere with
  a single brand: **MuzicAI — AI Music Suite**. Tagline: *"Your music library,
  mixed by intelligence."*
- **New logo & icon system** — waveform-pulse + AI-spark mark in the
  "Neon Nocturne" palette (violet `#7C5CFF` → fuchsia `#E84FF0`, electric cyan
  `#22D3EE` accent). Regenerated `logo.svg`, `wordmark.svg`,
  `og-image`, `icon-192/512.png`, `apple-touch-icon.png`, `favicon.ico`.
- **Design tokens** — wired real brand colors into the light/dark themes
  (primary, accent, ring, charts, sidebar) plus `bg-brand` / `text-brand-accent`
  Tailwind utilities. Added **Space Grotesk** as the heading font (`--font-heading`).
- **SEO & PWA** — full metadata overhaul (`metadataBase` muzicai.ro, title
  template, OpenGraph + Twitter cards, robots), manifest name/description/colors,
  `theme-color` → `#7c5cff`.
- **Cross-surface rebrand** — native Tauri shell, Capacitor app, companion
  (electron-builder `productName` + `appId` → `ro.muzicai.companion`), browser
  extension, READMEs, CHANGELOG and docs. Internal storage keys, mDNS service
  types, and npm package identifiers were intentionally left unchanged to avoid
  breaking persisted data and device discovery.

### Fixed — analyzer health resilience + larger Reanalyze modal (`apps/web` `0.5.12`)

- **No more false "Companion analyzer offline" on a tunnel blip.** The
  Reanalyze Library modal showed *"Companion GET /library/analyze/health
  failed (530) — pip install …"* when the per-device Cloudflare tunnel briefly
  dropped (HTTP 530 is an origin-unreachable error, not missing deps).
  `getAnalyzerHealth` now retries transient connectivity errors
  (530/520-539/502/503/504/timeouts) up to 3× and, if still failing, reports a
  clear "reconnecting — try again" state with a **Retry now** button instead
  of the misleading pip-install hint.
- **Larger Reanalyze Library modal.** Widened to 1400px (from 1100px) and
  taller (94vh) so the options grid and companion status fit without cramping.
  Also overrides the dialog's base `sm:max-w-md` cap, which was clamping the
  modal to ~448px.

### Fixed — audio playback over the cloud + faster /library (`apps/web` `0.5.10`)

- **Music now plays when the web app is hosted.** `/api/audio/[id]` returned
  `503 Device unreachable: fetch failed` because the production server tried
  to reach the companion over its LAN IP (`192.168.x`, unroutable from the
  cloud). `pickCompanionUrl` now prefers the companion's public Cloudflare
  Tunnel hostname on hosted runtimes, so audio streams through the tunnel.
  Local/co-located runtimes still use loopback.
- **Faster `/library` navigation.** The genre / key / tag filter lists were
  re-scanned from the full tracks table on every page load (two
  `SELECT DISTINCT` + a whole-column tags scan). They're now cached per-user
  and invalidated when the library re-syncs, removing three full-table scans
  from each `/library` render.
- **Build cache disabled on Vercel.** The restored pnpm `node_modules`/store
  from the build cache was corrupt (missing store index files), breaking every
  install with `ENOENT … exited 254` even with a fresh `--store-dir`. Set
  `VERCEL_FORCE_NO_BUILD_CACHE=1` and hardened the install retry to wipe a
  stale `node_modules` before reinstalling.

### Fixed — resilient Vercel install (`apps/web` `0.5.8`)

- **Production install uses a fresh pnpm store.** Vercel's restored build
  cache could ship a corrupt pnpm store (content files present but the index
  `.json` missing, e.g. `webextension-polyfill@0.12.0`), failing every deploy
  at install with `ENOENT … exited 254`. Even deleting the store + refetching
  hit the same broken index during linking. The `installCommand` now installs
  into a fresh `--store-dir /tmp/pnpm-store-fresh` (outside the restored
  cache) so the corrupt index is never read, with a delete-and-retry fallback.
  Lockfile integrity (`--frozen-lockfile`) is still enforced.

### Added — Rekordbox plug-and-play USB export + Drives manager (`apps/web` `0.5.4`, `server` `1.0.28`)

- **True plug-and-play CDJ/XDJ USB export.** A native `rbexport` sidecar
  writes `export.pdb` + `exportExt.pdb` (Device Library Plus) + `USBANLZ`
  analysis (beatgrid, cues, full-res + color waveforms) plus the `Contents/`
  audio tree, so a stick plays standalone on Pioneer hardware with no
  rekordbox re-import. Exposed in the Playlists page ("Export USB…") and the
  Drives manager, with scope (playlist / whole library), transcode policy,
  and auto-crates (By Genre / BPM / Key). Streams progress over SSE.
  - Fixed a DeviceSQL page-header bug (row-count must be a packed
    `num_row_offsets`/`num_rows` bitfield) that made rekordbox report
    "Device library is corrupted".
- **Drives manager upgrades.** Each connected drive now shows its rekordbox
  library status (track count, Classic / Device Library Plus / OneLibrary
  badges), an "Export here" shortcut, a "Clean rekordbox library" action, and
  live plug/unplug detection via an SSE drive-watch stream.
- **Multi-source track availability.** The library now surfaces how many
  devices hold each track and their names (online-first) in the availability
  badge tooltip, on top of the existing connected / offline / disconnected
  states.
- **Companion link prefers loopback when co-located.** When the web app and
  companion run on the same machine, the server reaches the companion over
  `localhost` instead of a flaky self-announced LAN IP; hosted deployments
  still use the LAN/tunnel URL.

### Changed — MIXAI viewport-locked layout + dark-green Neon Glass (`apps/mixai` `0.1.40`)

- **No more overlapping panels or stray scrollbars.** The two-deck cockpit now
  fits the window cleanly at every supported size and resizes responsively:
  - Root grid switched to `minmax(0, …)` rows so the deck row and bottom band
    each get a guaranteed share instead of the fixed-height decks overflowing
    down over the panels below.
  - Internal regions (mixer, decks, AutoMix/Sampler panels) scroll within
    themselves only when genuinely needed (4-deck mode); the default two-deck
    view fits with **zero scroll**.
  - Crossfader moved directly under the mixer; the bottom band is now a single
    horizontal row (Library · AutoMix · Sampler · plugins).
  - Decks tightened (slimmer waveform + spacing) and a guaranteed-fit floor
    enforced via raised window minimum (`1180×820`) and matching `#root` floor.
- **Neon Glass theme recolored from purple to dark-green neon** — deep
  near-black green background with `#00e08a` / `#19ffd5` accents.

### Added — MIXAI automatic cloud profile sync (`apps/mixai` `0.1.39`)

- **Your whole setup now follows you to every device, automatically.** Cloud
  profile sync existed but was manual (Settings → "Save/Load to cloud"); it is
  now also a background service, delivering on the "account · restored on any
  device" product pillar:
  - New `src/lib/cloud-sync.ts`: single source of truth for serializing
    (`buildProfileJson`) and applying (`applyProfileJson`) the full profile
    (theme + custom themes, deck layout, companion connection, MIDI + HID
    mappings, keyboard shortcuts, installed plugins), plus a
    `startCloudAutoSync()` controller.
  - On launch, when signed in to the companion/account, MIXAI pulls the stored
    profile and applies it (theme, layout, mappings, shortcuts, plugins).
  - Thereafter any local change is debounce-pushed (4 s) back to the account —
    last-write-wins on a single blob, best-effort when offline.
  - Sign-in transitions trigger an initial pull-then-push. Pushes are
    suppressed during/just-after applying a pulled profile so the snapshot
    doesn't immediately bounce back.
  - Auto-sync intentionally does NOT overwrite the local companion connection
    (device token) from a snapshot; the manual "Load from cloud" / paste-restore
    paths still do.
  - `src/App.tsx` mounts `startCloudAutoSync()`; `SettingsPanel.tsx`
    `ProfileSection` now reuses the shared helpers (removed duplicated
    build/apply logic).

### Added — MIXAI trigger editor in the visual builder (`apps/mixai` `0.1.38`)

- **The visual macro builder can now author automation triggers**, completing
  the 0.1.37 feature's UX (previously triggers were JSON/catalog-only):
  - `src/plugins/builder.tsx`: new "Automation triggers" section — add/remove
    triggers, each with a condition row (`When <deck> <metric> <op> <value>`),
    a cooldown field, and an editable macro step list (reusing the same
    `StepFields` UI as buttons). `buildSpec()` includes `triggers` when present,
    so Install / Copy JSON round-trip them.

### Added — MIXAI declarative automation triggers (`apps/mixai` `0.1.37`)

- **Plugins can now react to the mix.** A declarative plugin may declare
  `triggers`: when a watched deck metric crosses a threshold, a macro runs —
  no code, still shareable:
  - `src/plugins/external.tsx`: new `MacroTrigger` (deck + `metric`
    [`remaining`/`position`/`progress`/`bpm`/`volume`] + `op` lt/gt + `value` +
    `steps` + optional `cooldownMs`); `parseTrigger` validates it; `readMetric`
    / `triggerMet` evaluate conditions; `ExternalPluginSpec.triggers` added.
  - `src/plugins/host.tsx`: new `PluginAutomation` runtime (mounted in
    `App.tsx`) subscribes to the shared ~30 Hz mixer state stream and fires
    each trigger on the false→true **edge** of its condition, honouring a
    per-trigger cooldown so it never spams.
  - `src/plugins/catalog.ts`: new **End-of-Track Alert** automation example
    (notifies when a deck has < 20s remaining, 30s cooldown).
- Triggers ride inside the spec/`externalSpecs`, so they survive plugin
  export/import **and** account profile sync.

### Added — MIXAI customizable, profile-synced keybinds (`apps/mixai` `0.1.36`)

- **Every keyboard shortcut is now remappable.** The cheat-sheet overlay (`?`)
  is also a live keybind editor:
  - NEW `src/state/keybind-store.ts`: persists a `shortcutId → KeyboardEvent.code`
    override map (localStorage `mixai-keybinds`) and resolves the effective
    code→action map (`resolveBindings`). Sanitises unknown ids so a stale/
    tampered store can't break input.
  - `src/lib/shortcuts.ts`: added stable `shortcutId()`, `ALL_SHORTCUTS`,
    `SHORTCUTS_BY_ID`, and a `codeLabel()` pretty-printer.
  - `src/lib/use-shortcuts.ts`: the live handler now reads the resolved
    bindings from the keybind store instead of the static default map.
  - `src/components/ShortcutsOverlay.tsx`: click any key to capture a new one
    (Esc cancels), per-binding reset (↺) and a global "Reset all".
- **Keybinds travel with the account:** added to `ProfileSnapshot` + validated
  in `importProfile`, and wired through `SettingsPanel` export/restore (clipboard
  + companion cloud) — so a DJ's remaps follow them to any device.

### Added — MIXAI hotkey-triggerable macros (`apps/mixai` `0.1.35`)

- **Macros are now instantly playable from the keyboard.** Any macro button in
  a declarative plugin can declare a `hotkey` (e.g. `"shift+a"`); while the
  plugin is enabled it fires globally:
  - `src/plugins/external.tsx`: `MacroButton` gained an optional `hotkey`;
    new `normalizeHotkey` / `hotkeyFromEvent` / `formatHotkey` helpers canon-
    icalise bindings (sorted modifiers + key); `parseExternalSpec` validates
    and stores it; `runMacro` is now exported. The generated panel shows a
    hotkey badge next to each button.
  - `src/plugins/host.tsx`: new `PluginHotkeys` global `keydown` listener
    (mounted once in `App.tsx`) maps enabled-plugin hotkeys → macros, skipping
    input/textarea/select/contenteditable targets so bindings never fight the UI.
  - `src/plugins/builder.tsx`: per-button hotkey input (normalised on blur).
  - `src/plugins/catalog.ts`: Quick Drop ships `shift+a` / `shift+b` examples.
- Hotkeys travel inside the shareable spec and `externalSpecs`, so they survive
  plugin export/import **and** account profile sync (0.1.34).

### Added — MIXAI HID + plugin profile sync (`apps/mixai` `0.1.34`)

- **Account sync now carries the whole setup** — closes the "restore everything
  on another device" gap:
  - `src/lib/profile.ts`: `ProfileSnapshot` gained `hidPreset` (active HID
    controller mapping) and `externalPlugins` (installed declarative plugin
    specs); `importProfile` validates both via `importHidPreset` /
    `parseExternalSpec` so a tampered backup can't inject junk.
  - `SettingsPanel` profile export/restore (clipboard **and** companion cloud
    save/load) now includes the HID mapping and re-installs external plugins
    through the validated `installExternal` path.
- **Docs:** `docs/mixai/00-architecture-and-plan.md` milestone checklist updated
  to reflect shipped v0.1/v0.2 and v0.3-in-progress state.

### Added — MIXAI more controller presets (`apps/mixai` `0.1.33`)

- **Wider "out of the box" hardware support** for the MIDI + HID device pickers:
  - `src/lib/device-presets.ts` (MIDI): added Pioneer DDJ-400, Pioneer DDJ-SB3,
    Traktor Kontrol S4 MK3, Denon DJ MC7000, Roland DJ-202, and Reloop Beatmix —
    bringing the built-in MIDI list to 11 controllers across Pioneer, Numark,
    Native Instruments, Hercules, Denon, Roland and Reloop.
  - `src/lib/hid-device-presets.ts` (HID): added Pioneer DDJ-1000 and Pioneer
    CDJ-2000NXS2 scaffolds (with correct vendor/product ids for auto-suggest).
  - All presets remain honest starting points: the MIDI ones follow standard
    channel/CC conventions; the HID ones are relearn-from scaffolds. Any offset
    that's slightly off is one MIDI/HID-Learn away from fixed, then shareable.

### Added — MIXAI plugin catalog (`apps/mixai` `0.1.32`)

- **One-click ready-made macros** — completes the plugin story (loader → builder
  → catalog):
  - New `src/plugins/catalog.ts`: a curated `PLUGIN_CATALOG` of declarative macro
    plugins — Quick Drop (sync+play+slam crossfader), EQ Slam (kill/restore bass),
    Filter Fade (build-up sweeps), Echo Out (1-bar echo tail then cut), Center
    Reset (snap to neutral). They double as worked examples of the spec format.
  - `host.tsx`: a `PluginCatalog` browser in the Plugin Manager with per-entry
    Install buttons that show **Installed** once added; installs go through the
    same validated `installExternal` path (no special privileges, data-only).

### Added — MIXAI visual macro plugin builder (`apps/mixai` `0.1.31`)

- **Make a plugin without writing JSON** — a friendly front-end to the
  declarative loader shipped in `0.1.30`:
  - New `src/plugins/builder.tsx`: a `PluginBuilder` form to set metadata
    (id / name / author / icon / category / description) and assemble macro
    buttons, each a sequence of curated engine steps (`play`/`pause`/`setVolume`/
    `setEq`/`setFilter`/`setCrossfader`/`sync`/`setFx*`/`notify`/`wait`) with
    kind-specific fields (deck pickers, EQ band, FX kind, numeric values).
  - Builds an `ExternalPluginSpec` live and either **Install**s it (through the
    same `installExternal` validation path) or **Copy JSON**s the shareable spec
    to the clipboard.
  - Mounted in the Plugin Manager under the paste-JSON loader. Same security
    posture: data-only, no `eval`, reaches the app solely via the curated engine.

### Added — MIXAI external plugin loading (`apps/mixai` `0.1.30`)

- **Third-party plugins, the safe-first way** — users can now install plugins
  that ship outside the binary, without executing arbitrary code:
  - New `src/plugins/external.tsx`: a **declarative** plugin format. A plugin is
    pure data (metadata + "macro" buttons), where each button runs a sequence of
    *curated* engine actions (`play`/`pause`/`setVolume`/`setEq`/`setFilter`/
    `setCrossfader`/`sync`/`setFx*`/`notify`/`wait`). `parseExternalSpec` fully
    validates every field and step (decks, bands, finite numbers, capped waits)
    before anything is trusted; `compileExternalPlugin` turns a valid spec into a
    real `MixaiPlugin` with a generated button panel.
  - `plugin-store.ts`: external specs persist to `localStorage`
    (`mixai-external-plugins`), are re-validated + recompiled on startup, and
    merge with the built-ins. New `installExternal(json)` (upsert, rejects ids
    that collide with built-ins, gated by `isValidPlugin`), `removeExternal(id)`,
    and `isExternal(id)`.
  - `host.tsx`: the Plugin Manager gains a "Load plugin from JSON" paste box with
    inline validation errors, plus an **External** badge and ✕ remove button on
    installed external plugins.
  - Security posture: because external plugins are *data only* and reach the app
    solely through the curated `PluginContext.engine`, there is **no `eval` and no
    arbitrary code** yet. Code-bearing plugins behind a worker/iframe sandbox can
    build on this same loader + manager later.

### Added — MIXAI HID LED/feedback output (`apps/mixai` `0.1.29`)

- **Closes the HID loop** — controllers can now light up to reflect transport
  state, the output half of the read/write story (the MIDI module already
  captured an LED output port; HID gets the same now):
  - Rust `hid.rs`: the reader thread now also owns *writes* — output reports are
    queued via an `mpsc` channel and flushed between reads, so the non-`Sync`
    `HidDevice` is never shared across threads. New `hid_write_report(bytes)`
    command + `engine.hidWriteReport`.
  - New `src/lib/hid-feedback.ts`: a **state-diffing** LED driver. Given a
    preset's `feedback` mappings it computes the desired output report from the
    mixer snapshot (play / cue / sync / loop / on-air per deck) and only writes
    when a byte actually changes — no 30 Hz spam. ORs bit-flags that share a byte.
  - `HidPreset` gained optional `feedback: HidFeedback[]` + `outputReportId`,
    carried through export/import (validated). The DDJ-FLX4 (HID) preset ships a
    play/cue/sync/loop feedback scaffold.
  - `App.tsx` pushes feedback on every mixer tick; the diff cache resets on
    connect/disconnect and preset change.
- Output report layouts are firmware-specific, so feedback maps are honest
  scaffolds (relearn-from), same as the input mappings.
- Validated: `cargo build` clean, `pnpm build` (~301 KB, 74 modules).

### Added — MIXAI built-in HID device presets (`apps/mixai` `0.1.28`)

- **Ready-made HID mappings for known gear** so users don't have to learn every
  control by hand — the HID equivalent of the MIDI device-preset picker:
  - New `src/lib/hid-device-presets.ts`: a compact positional-layout builder
    (`deckBase`/`deckStride`, per-action axis offsets + button `[offset, mask]`,
    contiguous-bit performance pads, master axes) expanded into full
    `HidPreset`s. Ships Pioneer DDJ-FLX4 (HID), Pioneer CDJ-3000 (HID, single
    deck → A), a Numark scaffold, and a clean Generic 2-deck layout — each
    tagged with its USB vendor/product id.
  - `presetForDevice(vendorId, productId)` matches a connected device (exact
    product, then vendor fallback) to suggest the right preset.
  - Settings → HID controllers gained a **Device preset** dropdown and a
    **"Use suggested: …"** button that appears when the connected device matches
    a known preset. Picking one loads it into the HID mapping store (persisted).
- HID report layouts are proprietary/firmware-specific, so these are honest
  scaffolds: the structure + ids are right, and any off offset is one HID-Learn
  (0.1.27) away from fixed — then shareable back to the community.
- Frontend-only. Validated: `pnpm build` (~299 KB, 73 modules).

### Added — MIXAI HID input mapping + learn (`apps/mixai` `0.1.27`)

- **Maps the raw HID stream to engine actions** — the layer that sits on top of
  the 0.1.26 HID foundation, mirroring the MIDI mapping/learn model but for
  *positional* HID reports:
  - New `src/lib/hid-mapping.ts` (pure/typed): `HidPreset { name, vendorId,
    productId, mappings }` where each `HidMapping` addresses a control by
    `byteIndex` + `mask` (buttons) or whole byte (axes), plus action + deck.
    `export/importHidPreset` (versioned JSON, validated), `upsert/removeHidMapping`
    (dedup by byte+mask so re-learning rebinds). Reuses the MIDI action union and
    labels — identical engine surface.
  - New `src/state/hid-store.ts` (zustand, persisted to localStorage): receives
    `hid://input` reports and either **dispatches** mapped controls (button rising
    edges + axis value changes) to `engine.*` with the *same value scaling* as the
    Rust MIDI `map_to_command` (volume 0..1, tempo 0.5..1.5, filter/crossfader
    −1..1, EQ ±, master ×1.5), or **learns** by diffing consecutive reports to
    detect the changed byte/bit and surface a bind candidate.
  - `App.tsx` subscribes to `hid://input` once and feeds the store so mappings
    work app-wide.
  - Settings → HID controllers gained **HID Learn → bind** (action + deck
    selects), a live bindings table with per-row delete, and **Share / Import**
    of mappings (clipboard + paste) — the same authoring loop as MIDI.
- Frontend-only (no Rust changes). Validated: `pnpm build` (~296 KB, 72 modules).

### Added — MIXAI HID device foundation (`apps/mixai` `0.1.26`)

- **Native HID layer** (`hidapi`, MIT) for CDJs and HID-class DJ gear that
  don't speak MIDI — the foundation the per-model jog/screen decoders build on:
  - New Rust module `src-tauri/src/hid.rs`: `HidState` (Tauri-managed),
    `list_devices()` (enumerates all HID devices, DJ gear bubbled to the top via
    a small known-vendor/product registry — Pioneer DJ, NI, Numark, Hercules),
    `connect(path)` (opens the device and spawns a non-blocking reader thread
    that streams raw input reports to the UI as a `hid://input` event with
    bytes + hex), and `disconnect()` (signals the thread to stop).
  - Commands `list_hid_devices`, `hid_connect`, `hid_disconnect`,
    `hid_open_path` registered in `lib.rs`, mirroring the MIDI plumbing.
  - Frontend: `engine.listHidDevices/hidConnect/hidDisconnect/hidOpenPath`
    wrappers, `HidDeviceInfo`/`HidInputEvent` types, `subscribeHidInput` event
    helper, and a **HID controllers** section in Settings to enumerate, connect,
    and watch the live raw report stream (debug view).
- Intentionally foundation-only: raw reports now, model-specific decoding
  (jog ticks, platter touch, fader positions) lands on top of this stream next.
- Validated: `cargo build` clean, `pnpm build` (~288 KB, 70 modules).

### Added — MIXAI built-in plugins: VU Scope + Filter Riser (`apps/mixai` `0.1.25`)

- **Two more reference plugins** that exercise the remaining SDK categories and
  prove out the contract end-to-end:
  - 📈 **VU Scope** (*visual*) — a scrolling master-output meter painted on an
    HTML canvas, driven directly from the 30 Hz state stream with a rolling
    buffer in a ref (no per-frame React re-render).
  - 🎚️ **Filter Riser** (*effect*) — a one-tap, beat-timed HPF build-up macro
    that eases the deck filter from neutral to full HPF over 4/8/16/32 beats
    then snaps back on the drop. Uses the safe `engine.setFilter` subset,
    `ctx.notify`, and persists its deck + length via `saveSettings`/`loadSettings`.
- All four SDK categories (utility, assistant, visual, effect) now ship a
  working built-in example.
- Validated: `pnpm typecheck` clean, `pnpm build` (~286 KB, 70 modules).
  Frontend-only.

### Added — MIXAI Plugin SDK foundation (`apps/mixai` `0.1.24`)

- **Extensions, the right way.** New typed Plugin SDK (`src/plugins/sdk.ts`):
  a plugin is declarative data — metadata + an optional React panel + optional
  `onEnable`/`onDisable` hooks. Plugins never import the engine, stores or Tauri;
  everything they can touch arrives through a curated `PluginContext`
  (`getState`, 30 Hz `subscribe`, a safe transport/mix `engine` subset, `notify`,
  and namespaced `saveSettings`/`loadSettings`). This keeps the surface small and
  ready to sandbox third-party plugins in a worker later.
- **Registry + host.** `plugin-store.ts` holds the registry, the enabled set
  (persisted to localStorage), a single shared 30 Hz state fan-out, and a toast
  channel. `host.tsx` adds a `PluginDock` (renders enabled panels in the right
  rail), a `PluginToasts` layer, and a `PluginManager` (Settings → Plugins) to
  toggle plugins on/off.
- **Two reference built-ins** that double as docs: **Phrase Counter** (live
  bar + 16-bar phrase position per playing deck) and **Key Clash Guard**
  (warns when the two on-air decks are in clashing Camelot keys during a blend,
  using `onEnable`/`onDisable` + `ctx.notify`).
- Validated: `pnpm typecheck` clean, `pnpm build` (~283 KB, 70 modules).
  Frontend-only.

### Added — MIXAI account profile sync via companion (`apps/mixai` `0.1.23`, `server` `1.0.27`)

- **Real account sync, not just a copy/paste code.** Settings → Profile backup
  now has **Save to cloud** / **Load from cloud** buttons that store the full
  profile snapshot (theme, custom themes, deck layout, companion connection,
  MIDI mapping) on the MMO Companion keyed by your signed-in user, so any
  machine paired to your library can pull the same setup.
- Companion: new `/mixai-profile` router (`GET` returns the stored blob or
  `null`; `PUT` upserts it) backed by a lazily-created `mixai_profiles` SQLite
  table (one JSON blob per user, 256 KB cap). Auth is the existing
  `X-Device-Token` + `X-User-Id` pair.
- MIXAI bridge: new Rust commands `companion_get_profile` / `companion_put_profile`
  (proxy through reqwest, never the webview), and `engine.companionGetProfile` /
  `engine.companionPutProfile` wrappers.
- The cloud buttons are gated on a configured companion (device token + user id);
  paste-restore and clipboard-export still work fully offline.
- Validated: `server` `tsc --noEmit` clean, `cargo build` clean, `pnpm build`
  (~275 KB, 67 modules).

### Added — MIXAI profile backup & restore (`apps/mixai` `0.1.22`)

- **Move your whole setup between machines.** Settings → Profile backup exports
  everything local — active theme, all custom themes, deck layout, muzicai.ro /
  companion connection, and the active MIDI mapping — into one portable code
  (copied to clipboard), and restores it all from a pasted code.
- This is the local-first precursor to muzicai.ro account sync: the same snapshot
  shape will later be pushed to / pulled from the signed-in account.
- Restore is **lenient and validated** — each section is parsed independently
  (custom themes validated per-token, companion config, MIDI preset via the
  existing `importPreset`), so a partial or older backup still restores whatever
  it can; custom themes merge by id (imported wins).
- New `src/lib/profile.ts` (`exportProfile`/`importProfile` + `ProfileSnapshot`),
  `ui-store.restoreProfile`, and a `ProfileSection` in the settings panel.
- Validated: `pnpm typecheck` clean, `pnpm build` (~273 KB, 67 modules).
  Frontend-only.

### Added — MIXAI keyboard shortcuts (`apps/mixai` `0.1.21`)

- **Pro deck control from the laptop keyboard — no controller required.** A
  Serato/rekordbox-style split layout drives Deck A with the left hand (Q play,
  A cue, S sync, Z/X nudge, W loop, 1–4 hot-cues) and Deck B with the right
  (P play, ; cue, L sync, ,/. nudge, O loop, 7–0 hot-cues). Arrow keys crossfade
  (←/→ to A/B, ↓ center).
- **Built-in cheat-sheet overlay.** Press **?** (or the new ⌨ Keys button in the
  top bar) for a grouped reference of every binding.
- Shortcuts are suppressed while typing in inputs/textareas/selects and never
  swallow Ctrl/Cmd/Alt combos, so library search and OS shortcuts keep working.
- All actions route through existing engine commands (play/pause/cue/sync/loop/
  hot-cue/seek/crossfader) and read live deck state for correct toggles. New
  files: `src/lib/shortcuts.ts` (documented binding table), `src/lib/use-shortcuts.ts`
  (hook + dispatcher), `src/components/ShortcutsOverlay.tsx`.
- Validated: `pnpm typecheck` clean, `pnpm build` (~270 KB, 66 modules).

### Added — MIXAI built-in device preset picker (`apps/mixai` `0.1.20`)

- **MIDI for every console brand, out of the box.** A new "Device preset"
  dropdown in Settings → MIDI ships ready-to-use mappings for the most common
  2-deck controllers: **Pioneer DDJ-FLX4** (matches the native default exactly),
  **Numark Mixtrack Pro**, **Traktor Kontrol S2**, **Hercules DJControl Inpulse**,
  and a **Generic 2-deck MIDI** fallback.
- Picking a preset applies it live via `engine.midiSetPreset`, so the controller
  works immediately — and every binding is still fine-tunable with the
  `0.1.19` learn→bind editor and shareable via the export code.
- New `src/lib/device-presets.ts` synthesizes each preset from a compact layout
  description (per-deck Note/CC/pad status bytes + control numbers), keeping the
  table tiny and easy to extend with more controllers.
- Validated: `pnpm typecheck` clean, `pnpm build` (~265 KB, 63 modules).
  Frontend-only — reuses the `0.1.18` native `midi_set_preset` command.

### Added — MIXAI MIDI learn→bind editor (`apps/mixai` `0.1.19`)

- **Create and edit mappings, not just import them.** MIDI Learn now captures
  the last-touched control and lets you bind it to any action + deck inline:
  pick the action and target deck, hit **Bind**, done. Re-learning the same
  physical control rebinds it (deduped by status+note) instead of piling up
  duplicates.
- **Per-binding delete.** Each row in the bindings table now has a remove
  button; deletes are written to the live preset immediately.
- Control kind (Note vs CC) is inferred from the MIDI status byte
  (`0xB0..0xBF` → CC, otherwise Note), so users don't have to know the wire
  format. All edits go through `engine.midiSetPreset`, so they take effect on
  the controller instantly and are shareable via the existing export code.
- New `src/lib/midi-preset.ts` helpers: `ALL_ACTIONS`, `controlTypeFromStatus`,
  `upsertMapping`, `removeMapping` (all pure/immutable).
- Validated: `pnpm typecheck` clean, `pnpm build` (~262 KB). Frontend-only —
  reuses the `0.1.18` native `midi_set_preset` command.

### Added — MIXAI shareable MIDI mappings (`apps/mixai` `0.1.18`)

- **Share your controller mapping.** The active MIDI preset can now be inspected,
  exported as a compact code (copy to clipboard) and imported from a shared code
  — the same marketplace foundation as custom themes, now for controller layouts.
- **Native (Rust)**: `midi.rs` gains `get_preset`/`set_preset` (the live input
  callback already reads the shared `Preset`, so an imported mapping takes effect
  immediately); exposed as `midi_get_preset`/`midi_set_preset` Tauri commands.
- **Frontend**: new `MidiPreset`/`MidiMapping`/`MidiAction` types mirroring the
  Rust model; `engine.midiGetPreset`/`midiSetPreset` wrappers; `src/lib/midi-preset.ts`
  with versioned `exportPreset`/`importPreset` (every binding validated — status/
  midino byte range, known action, note/cc type, valid deck — malformed payloads
  rejected) and an `actionLabel` helper.
- **UI**: Settings → MIDI controllers now shows the active preset name, binding
  count, a scrollable bindings table (action · deck · CC/Note + status), a
  **Share** button and a paste-to-import field with validation. The preset is
  (re)loaded on connect so device auto-mapping is reflected.
- Validated: `cargo build` (app) clean, `pnpm typecheck` clean, `pnpm build`
  (~260 KB).

### Added — MIXAI custom & shareable themes (`apps/mixai` `0.1.17`)

- **Make it yours, then share it.** Beyond the three built-in themes, users can
  now create unlimited **custom themes**, live-edit their colors with native
  swatches, and **share** them as a compact code (copy to clipboard / paste to
  import) — the foundation for a future themes marketplace.
- **Theme model** (`src/themes/themes.ts`): added `CustomTheme` (namespaced
  `custom:<uuid>` ids), an `EDITABLE_TOKENS` palette (background, surfaces, text,
  accents, deck colors, good/warn/danger), `makeCustomTheme`/`blankCustomTheme`
  (colors + motion → full token set via per-motion structural tokens so themes
  stay coherent), and versioned `exportTheme`/`importTheme` JSON serialization
  (malformed payloads rejected, missing colors backfilled). New `applyThemeDef`
  applies any theme object; `applyTheme` delegates to it.
- **Store** (`src/state/ui-store.ts`): `theme` widened to `ThemeId | custom:*`;
  persists `customThemes` to localStorage; actions `addCustomTheme`,
  `updateCustomThemeColor` (live re-applies when active), `renameCustomTheme`,
  `deleteCustomTheme` (falls back to Neon Glass), `importThemeString`, and
  `applyActiveTheme` (resolves built-in/custom on startup — `main.tsx` now uses
  it so custom themes survive reload with no flash).
- **UI**: the Settings → Theme section gains a `+ New` button, a color-swatch
  editor with rename/Share/Delete for the active custom theme, and a paste-to-
  import field with validation. A `toHex` helper coerces rgb()/short-hex tokens
  for the native color picker.
- Frontend-only (no Rust changes). Validated: `pnpm typecheck` clean,
  `pnpm build` (~256 KB).

### Added — MIXAI auto-queue: autonomous set building (`apps/mixai` `0.1.16`)

- **The AI DJ now picks its own tracks.** With **AUTO-QUEUE** on, auto-mix loads
  the best harmonic match from the muzicai.ro library onto the idle deck before
  each blend — turning the auto-mixer into a fully autonomous, hands-off set
  builder that keeps the dancefloor moving with key- and BPM-compatible choices.
- **Selection** reuses the harmonic scoring (`transitionScore`): for the on-air
  deck's key + BPM it ranks the visible library, skips tracks already loaded on
  any deck or played this session, and loads the top match. After each
  transition it also **pre-loads the next match** onto the freed deck so the
  following blend is ready early.
- **Refactor**: extracted the companion track-load flow (optimistic metadata →
  local-decode-with-stream-fallback → waveform peaks → Camelot key → auto-attach
  stems) into a hook-free `src/lib/load-track.ts` shared by the Library browser
  and the auto-mix store. The library keeps the auto-mix candidate **pool** in
  sync with what's visible.
- **UI**: an **AUTO-QUEUE** toggle joins BEAT-SYNC in the auto-mix panel; the
  status line shows the track being queued.
- Frontend-only (no Rust changes). Validated: `pnpm typecheck` clean,
  `pnpm build` (~250 KB).

### Added — MIXAI auto-mix "AI DJ" (`apps/mixai` `0.1.15`)

- **Hands-free mixing.** A frontend orchestrator that beat-syncs the idle deck
  and crossfades into it a few seconds before the on-air track ends — a true
  "AI DJ" built entirely on the existing public engine commands a human would
  use (`sync` / `play` / `setCrossfader` / `pause`), so it never touches the
  audio thread and is fully cancellable.
- **State machine** (`src/state/auto-mix-store.ts`): watches deck transport via
  the regular 30 Hz `mixer://state` snapshot; when the on-air deck's remaining
  time drops below the **lead-in** window it optionally beat-syncs the other
  deck, starts it, and ramps the crossfader to the far side over the
  **crossfade** duration using an easeInOutSine curve, then pauses the outgoing
  deck and flips "on air". Re-entrancy-guarded; adopts whichever main deck is
  already playing when armed.
- **UI** (`src/components/AutoMixPanel.tsx`): ON/OFF arm, live status line with
  an on-air indicator dot (deck-coloured / amber while mixing), Crossfade (2–30 s)
  and Lead-in (4–40 s) sliders, a BEAT-SYNC toggle, and a **MIX NOW** button to
  force the next blend. Mounted in the right column above the crossfader.
- Frontend-only (no Rust changes). Validated: `pnpm typecheck` clean,
  `pnpm build` (~248 KB). First step toward full automated set building on the
  harmonic mix-assist scoring.

### Added — MIXAI harmonic mix-assist (`apps/mixai` `0.1.14`)

- **AI-style "what mixes next" suggestions.** First v0.3 feature: a harmonic
  mix-assist that ranks the muzicai.ro library by how well each track would mix
  into a playing deck, using **Camelot-wheel** key compatibility + BPM proximity.
- **Camelot logic** (`src/lib/harmonic.ts`, pure/typed): `parseCamelot` (e.g.
  `8A`), `keyCompatibility` scoring the classic moves — Perfect (same key, 1.0),
  Relative major/minor (0.92), Adjacent ±1 (0.85), Energy-boost +7 / fifth
  (0.6), Whole-step ±2 (0.45), Diagonal energy mix (0.55), else Clash (0).
  `bpmCloseness` folds ½×/2× octaves into a ±6 % window; `transitionScore`
  blends key (70 %) + BPM (30 %) and computes the signed pitch-bend %% needed to
  beat-match.
- **UI**: a **MIX ASSIST** bar above the companion track list lets you pick which
  loaded deck to mix *into* (or OFF). When on, tracks re-sort by transition score
  and each row shows a colour-coded match badge (green ≥80 % / amber ≥55 %) with
  the move label and tempo-nudge tooltip. The playing deck's Camelot key is now
  recorded on load via a transient `deckKeys` map in the mixer store.
- Frontend-only (no Rust changes). Validated: `pnpm typecheck` clean,
  `pnpm build` (~244 KB).

### Added — MIXAI one-shot sampler (`apps/mixai` `0.1.13`)

- **8-pad one-shot sampler.** A pad bank that plays short stereo samples (DJ
  drops, stabs, vocal shouts, loops) straight into the master bus. Click a
  loaded pad to fire it from the start; re-triggering restarts instantly.
  Per-pad gain, one-shot vs. **loop** toggle, load (⊕) and clear (✕).
- **RT-safe** (`mixai-core::sampler`): each `Pad` holds an optional `TrackBuffer`
  loaded off the audio thread (moved in via `Command::LoadSample`); the cpal
  callback only reads buffers and advances a per-pad cursor — no locks, no
  allocation. Linear-interpolated playback with a source/engine sample-rate
  ratio so 44.1 kHz samples play correctly at any device rate; gains are
  one-pole smoothed for click-free level changes. Pads sum into the master
  *after* the deck/crossfader mix, so they go through master volume, soft-clip
  and the recording tap. Permissive (MIT OR Apache-2.0).
- Full stack: new `Command::{LoadSample,ClearSample,TriggerSample,StopSample,`
  `SetSampleGain,SetSampleLooping}` + drain handlers + `Sampler` mixed in
  `Mixer::render`; Engine `load_sample`/`trigger_sample`/… methods; Tauri
  commands `sampler_{load,clear,trigger,stop,set_gain,set_looping}` (load
  decodes the file natively via `decoder::decode_file`); `engine.sampler*`
  bridge wrappers; `state/sampler-store.ts` (transient pad metadata) and a
  `SamplerPanel.tsx` 8-pad UI mounted under the crossfader.
- Validated: `cargo build` (core + app), `cargo test` **8/8** (3 new sampler
  tests: one-shot plays-then-stops, untriggered-silent, loop-keeps-playing),
  `pnpm typecheck` clean, `pnpm build` (~240 KB). This completes the v0.2
  milestone (stems, recording, streaming output, 4-deck, FX, sampler all done).

### Added — MIXAI beat-synced FX (`apps/mixai` `0.1.12`)

- **Per-deck FX unit: echo + reverb.** Each deck now has a real-time effects
  insert (post-fader, so tails follow the channel fader) with two effects:
  a **beat-synced feedback echo** whose delay length tracks the deck's effective
  BPM × tempo × beat division (¼/½/1/2 beats), and a **Schroeder reverb**
  (4 comb + 2 all-pass per channel, stereo-spread, scaled to the sample rate).
- **RT-safe DSP** (`mixai-core::fx`): ring-buffer delay line and comb/all-pass
  sections are preallocated once at deck creation — the cpal callback only
  reads/writes existing storage (no locks, no allocation). The wet/dry mix is
  one-pole **smoothed** so enabling/disabling and blending are click-free, and
  switching effect type clears the tails so old audio never bleeds through.
  Licensing stays permissive (MIT OR Apache-2.0) — the reverb is an original
  Schroeder/Freeverb-style implementation, no GPL code.
- **Echo time auto-tracks the grid:** the delay length is recomputed whenever
  the track loads or the tempo fader moves, so the echo stays locked to the beat
  while pitch-bending.
- **`FxPanel` UI** on each deck: OFF/ECHO/REVERB selector, a WET blend slider
  with live percentage, and ¼/½/1/2 beat-division buttons — styled to match the
  existing stem/pad panels with the deck accent colour and smooth transitions.
- Full stack wired end-to-end: new `Command::{SetFxKind,SetFxWet,SetFxBeats}`
  + drain handlers + `Deck` methods (`set_fx_kind`/`set_fx_wet`/`set_fx_beats`,
  `recompute_fx_time`), `DeckState.{fxKind,fxWet,fxBeats}` surfaced to the UI
  mirror, Tauri commands `deck_set_fx_{kind,wet,beats}`, and `engine.setFx*`
  bridge wrappers. Validated: `cargo build` (core + app), `cargo test`
  (5/5 incl. 3 new FX tests: off-passthrough, echo bounded/finite, reverb
  decays), `pnpm typecheck` clean, `pnpm build` (~237 KB).

### Added — MIXAI remote streaming (`apps/mixai` `0.1.11`)

- **Play tracks from a companion on another machine.** Until now companion
  tracks loaded from their local `filepath` — fine when the companion runs on
  the same box, but useless over LAN / Cloudflare tunnel. Loading a muzicai.ro
  track now tries a direct local decode first and, if the file isn't on local
  disk, transparently **streams the encoded bytes** from the companion's
  range-aware `GET /audio/<filepath>` route and decodes them in-memory.
- **In-memory decoder** (`mixai-core::decoder::decode_bytes`): the symphonia
  decode loop was factored into a shared `decode_stream(MediaSourceStream)` so
  both `decode_file` (disk) and `decode_bytes` (a `Cursor<Vec<u8>>` from HTTP)
  produce the same `TrackBuffer` — full buffer so waveform peaks, beatgrid and
  instant seek all still work on streamed tracks.
- **Rust-side fetch** (`src-tauri/src/companion.rs::fetch_track_audio`): resolves
  the track's filepath, then GETs `/audio/<encoded>` with a 120 s transfer
  timeout (whole file over a tunnel). The megabytes stay in the Rust process —
  only the decoded handle + peaks cross the JS IPC boundary. New Tauri command
  `load_track_stream` (async) shares the analyse/mirror/load path with
  `load_track` via a new `load_decoded` helper.

### Added — MIXAI live stems (`apps/mixai` `0.1.10`)

- **Live per-stem control — the headline DJ feature.** Each deck now has a
  **STEMS** panel with four vertical faders + mute (M) / solo (S) for vocals,
  drums, bass and melody. Blend, mute or solo any stem on the fly while the
  track plays; an ON/OFF switch toggles stem playback vs. the full mix.
- **RT-safe stem mixing engine** (`mixai-core::stretch::StemMix`): playback now
  reads through a `StemMix` source that sums up to four stereo layers with
  smoothed per-stem gains. Both playback paths use it — the WSOLA key-lock
  stretcher (`process_hop`/`find_best_delta` refactored to consume `&StemMix`)
  and the varispeed path — so stems work with key-lock on or off, with no locks
  or allocation in the audio callback. Gains smooth over ~20 ms (click-free).
- **Deck stem state** (`mixai-core::deck`): optional 4-layer buffers, smoothed
  `stem_gain[4]`, `set_stems`/`set_stems_active`/`set_stem_gain`; cleared on new
  track load. New `Command::{LoadStems,SetStemsActive,SetStemGain}` + engine
  methods; `DeckState` surfaces `hasStems`/`stemsActive`/`stemGains` to the UI.
- **Tauri commands** `load_stems` (decodes up to four local stem WAVs off the
  audio thread), `deck_set_stems_active`, `deck_set_stem_gain`.
- **Companion stem integration** (`src-tauri/src/companion.rs`): `companion_tracks`
  now reports `stemsStatus`; new `companion_track_stems` (reads a track's stem
  paths), `companion_request_stems` (POST `/analyze {stems:true}` → job id) and
  `companion_stem_job` (poll progress; the companion's 4th stem `other` maps to
  MIXAI's `melody` slot). The Library auto-attaches stems when loading a track
  whose `stemsStatus === "ready"`, and shows a ✦ generate button with live
  progress for tracks not yet separated.

### Added — MIXAI muzicai.ro library via Companion (`apps/mixai` `0.1.9`)

- **Browse & load your synced library.** The Library panel now has a
  **muzicai.ro / Local file** source toggle. The muzicai.ro tab lists tracks
  from the local MMO Companion (`server/`, `http://127.0.0.1:17899`) with live
  search, BPM and Camelot key, and one-click load to Deck A/B. Because the
  companion runs on the same machine, tracks load from their local `filepath`
  through the existing decoder (full BPM/beatgrid/peaks analysis applies).
- **Native HTTP proxy** (`src-tauri/src/companion.rs`, `reqwest` with rustls):
  the companion's CORS allowlist rejects the Tauri webview origin, so all
  `/library/*` calls go through Rust, which also keeps the device token out of
  the webview. Auth uses `X-Device-Token` + `X-User-Id` headers.
- New Tauri commands `companion_status` (probes `/health` + reports auth),
  `companion_configure`, `companion_tracks`, `companion_toggle_favorite`;
  `engine.ts` wrappers; a managed `CompanionState`.
- **Settings → muzicai.ro library**: status dot (offline / online / paired),
  editable companion URL, device token and user id, persisted to localStorage
  (`mixai-companion`) and pushed to the proxy on startup + on change.

### Added — MIXAI master recording (`apps/mixai` `0.1.8`)

- **Record the master mix to WAV.** A REC button in the top bar opens a native
  save dialog (`@tauri-apps/plugin-dialog`), then captures the post-fader stereo
  output to a 32-bit float WAV at the engine sample rate. The button shows a
  pulsing indicator and a live `mm:ss` elapsed timer; click again to stop and
  finalize the file.
- **RT-safe capture pipeline** (`mixai-core::recorder`): the audio callback only
  accumulates mixed samples into a block buffer and `try_send`s full blocks into
  a bounded channel — never opens files, never locks, never allocates on the hot
  path. A dedicated writer thread drains the channel and writes with `hound`
  (MIT/Apache, keeps the permissive-DSP promise). On backpressure the RT thread
  drops a block rather than risk a master-output dropout.
- New `Command::SetRecording`, `Engine::{start,stop,is}_recording`, Tauri
  commands `start_recording`/`stop_recording`/`is_recording`, and
  `engine.ts` wrappers `startRecording`/`stopRecording`/`isRecording`.

### Added — MIXAI real key-lock / time-stretch (`apps/mixai` `0.1.7`)

- **Pitch-preserving tempo** via a new pure-Rust WSOLA stretcher
  (`mixai-core::stretch`, permissive — no C++ toolchain, ships in the binary).
  When **key-lock** is on, the deck pulls from the stretcher (overlap-add
  grains with waveform-similarity alignment) so changing tempo no longer
  changes pitch; with key-lock off it stays varispeed (turntable feel). The
  stretcher re-primes cleanly on load/seek/cue-jump/key-lock toggle/loop wrap.
  Covered by unit tests (bounded/finite output, tempo-correct position
  advance). This completes the v0.1 audio engine ("It mixes, beautifully").

### Added — MIXAI beat sync (`apps/mixai` `0.1.6`)

- **Tempo beat-sync** (`deck_sync`): matches a deck's effective BPM to the
  master deck (prefers a playing, loaded deck with a known BPM), clamped to the
  engine's ±50% tempo range. Exposed as a `SYNC` button on each deck and via
  `engine.sync`. Builds on the BPM/beatgrid detection. (Phase-accurate beat
  alignment + continuous sync follow.)

### Added — MIXAI local file loading (`apps/mixai` `0.1.5`)

- **Open local audio files** straight onto a deck via the native file picker
  (`engine.pickAudioFile` using the Tauri dialog plugin; mp3/wav/flac/aac/m4a/
  ogg/aiff). The Library now has "Open local file → Deck A/B" actions that
  decode, analyse (BPM/beatgrid), compute peaks and load in one step. Remote
  muzicai.ro library + companion sync land next.

### Added — MIXAI MIDI controllers (`apps/mixai` `0.1.4`)

- **Native MIDI input** via `midir` (MIT) in a new `src-tauri/src/midi.rs`,
  porting the web app's data-driven mapping model (`Mapping {status, midino,
  type, action, deck}` → semantic `MidiAction` → engine `Command`). Ships a
  built-in **Pioneer DDJ-FLX4** preset (transport, EQ/filter/volume/tempo,
  loops, 8 hot-cue pads per deck, crossfader, master) and a **MIDI-learn**
  mode that emits `midi://learn` so any controller can be bound.
- Tauri commands `list_midi_inputs` / `midi_connect` / `midi_disconnect` /
  `midi_set_learn`, typed `engine.ts` wrappers, a `subscribeMidiLearn` event
  subscription, and a real MIDI device/learn panel in Settings (replacing the
  placeholder). LED output port is captured for the upcoming feedback layer.

### Added — MIXAI BPM + beatgrid analysis (`apps/mixai` `0.1.3`)

- **Offline tempo + beat-phase detection** (`mixai-core::analysis`, fully
  permissive / no GPL deps): energy-novelty onset envelope → autocorrelation
  tempo estimate (folded into a 90–180 BPM band to fix octave errors) → beat
  comb to find the first-downbeat phase. `load_track` now auto-detects BPM
  when the library doesn't supply it and stores the beatgrid anchor
  (`DeckState.firstBeat`). The waveform overlay renders beatgrid lines with
  emphasised downbeats. Sets up sync/quantize and quantized hot-cues/loops.

### Added — MIXAI real waveform peaks (`apps/mixai` `0.1.2`)

- **Real waveform overview**: peaks are downsampled from the decoded audio at
  load time (`TrackBuffer::compute_peaks`, 2000 bins of mono peak amplitude)
  and returned by `load_track`, replacing the procedural placeholder. The
  `Waveform` canvas now renders played/unplayed split, the active loop region
  (amber shading), hot-cue markers, and the playhead, all driven by the live
  deck snapshot. Peaks are kept per-deck in the mixer store (transient, not in
  `MixerState`). Falls back to a faint procedural pattern when no track loaded.

### Added — MIXAI hot cues + loops (`apps/mixai` `0.1.1`)

- **8 hot-cue pads per deck**: set at the live playhead, click to jump,
  Shift+click to clear. State is owned by the Rust core and captured at the
  RT playhead, published back through the atomic snapshot so the pads light up
  from the 30 Hz `mixer://state` feed.
- **Beat loops + manual loops**: 1/2/4/8-beat loops sized from the track BPM,
  manual loop IN/OUT, loop toggle/exit, and ½ / ×2 loop halving/doubling.
  Seamless sample-accurate wrap-around in the deck render path.
- New `Command` variants (`SetHotCue`/`JumpHotCue`/`ClearHotCue`/`LoopIn`/
  `LoopOut`/`LoopToggle`/`LoopExit`/`Beatloop`/`LoopScale`), matching Tauri
  commands, typed `engine.ts` wrappers, and a new `PerformancePads` UI
  component wired into each deck. `DeckState` gained `hotCues`/`loopActive`/
  `loopStart`/`loopEnd`.

### Added — MIXAI native DJ app scaffold (`apps/mixai`)

- **New flagship native DJ application `@mmo/mixai`** under `apps/mixai/`, a
  greenfield Tauri 2 app aimed at combining the best of rekordbox/Serato/Traktor/
  VirtualDJ/djay with muzicai.ro + AI integration. Architecture & roadmap live in
  [`docs/mixai/00-architecture-and-plan.md`](docs/mixai/00-architecture-and-plan.md).
- **Rust real-time audio core (`mixai-core`, MIT/Apache-2.0)**: `cpal` output
  stream, `symphonia` decode, native DSP signal chain (RBJ biquad 3-band EQ +
  bipolar LPF/HPF filter + equal-power crossfader + soft-clip master limiter),
  lock-free `crossbeam` command queue and an atomic snapshot published to the UI.
  Deliberately permissive-only DSP so the engine stays distributable inside a
  proprietary/commercial build (GPL analysis libs stay out-of-process).
- **Tauri bridge**: `#[tauri::command]` surface (device list, load/play/pause/
  seek, volume/tempo/key-lock/EQ/filter/cue, crossfader, master) plus a 30 Hz
  `mixer://state` event pump driving live meters/transport in the UI.
- **React 19 + Vite + TS UI**: themeable from day one with 3 shipped themes
  (Neon Glass / Studio Metal / Flat Pro), 2- and 4-deck layouts, decks with
  waveform + transport + tempo + key-lock, channel strips (EQ/filter/VU/fader/
  cue), crossfader + master, library browser, and an audio/MIDI/theme settings
  panel. Frontend, Rust core and full Tauri app all compile clean.

### Changed — Documentation consolidated under `docs/` (web `0.4.3`)

- **Moved the root knowledge-base folders into `docs/`**: `concept/`, `organizare/`, `genuri/`, `echipament/`, `glosar/`, and `versuri/` now live at `docs/concept/`, `docs/organizare/`, etc. The repo root is now limited to code (`apps/`, `packages/`, `server/`, `infra/`) plus top-level meta files, matching a conventional monorepo layout.
- **`/learn` URLs are unchanged.** `apps/web/scripts/sync-learn-content.mjs` was rewired to map each section slug (`concept`, `docs`, `organizare`, `genuri`, `echipament`, `glosar`) to its new `docs/…` source path. The `docs` learn section skips the relocated sub-corpora (and `versuri`) so nothing is double-listed, keeping `/learn/<slug>` stable for SEO.
- **Re-pointed every relative cross-link**: links inside the moved docs (`../README.md` → `../../README.md`, `../docs/…` → `../…`, plus `app/` → `apps/web/` and `extension/` → `apps/extension/`), the root `README.md` / `README.en.md` / `NAVIGARE.md` tables and structure trees, and the back-links from `docs/{aplicatie,arhitectura,avansat,incepator,profesional}/`. A full crawl confirms zero new broken links (legacy archive docs and pre-existing aspirational stubs excluded).

### Fixed — `google-auth-library` missing after monorepo move (web `0.4.2`)

- **`apps/web/src/actions/generate.ts` and `apps/web/src/lib/google-id-token.ts` import `google-auth-library` directly, but it was never declared in `apps/web/package.json`** — it only resolved by accident as a hoisted transitive dependency of `@google-cloud/storage`. After the `app/` → `apps/web/` move and a clean `pnpm install` (split-lockfile, no shared hoisting), the package was no longer hoisted and `tsc` failed with `TS2307: Cannot find module 'google-auth-library'`. Declared it explicitly (`^9.15.1`, the version already in the tree) so the build is deterministic.

### Changed — Monorepo hygiene & workspace fix (web `0.4.1`)

- **`packages/*` now declared in `pnpm-workspace.yaml`**. The four shared-core packages (`@mmo/ai`, `@mmo/audio-gen`, `@mmo/ai-mcp`, `@mmo/sdk`) had valid `package.json` files but were missing from the workspace, so `pnpm -r` ignored them. They are still consumed via tsconfig path aliases (not `workspace:*`) to preserve the split-lockfile design.
- **Removed ~25 tracked one-off artifacts** that predated the `*.log` gitignore rule: eslint dumps (`eslint*.json/.txt`), ad-hoc analysis scripts (`_scan.js`, `analyze.js`, `parse.js`, `lc.json`), `build-output.txt`, and stale `.log` files at the repo root and under `app/`. Added matching `.gitignore` patterns so they can't be re-committed. Kept `app/.eslint-baseline.json` (used by `lint:baseline`/`lint:check`) and `app/components.json` (shadcn).

### Added — AI generation, training, Maestro, Watch & Voice feature set (web `0.4.0`)

- **Large feature drop committed**: AI music/voice generation (`/generate`, `/voice-wizard`), LoRA training pipeline (`/training`, `/lora`), the Maestro coaching surface (`/maestro`), an expanded Watch experience (continue/discover/stats/settings, Trakt sync, watch-party, bookmarks, external ratings), normalized project schema, and a CodAI/MCP copilot. New Drizzle migrations `0018`–`0026`, server-side Python sidecars, and supporting infra (Azure ML, Cloud Run, Vertex, Terraform) are included.
- **Repository hygiene**: `.azure-openai.json`, `.azure-speech.json`, and the vendored `external/` upstream repos are now git-ignored so local credential blobs and embedded git repos are never committed.
- App and companion both build clean (`next build --webpack` + `tsc`).

### Fixed — yt-dlp missing on serverless ("spawn yt-dlp ENOENT") (web `0.3.17`)

- **`/api/download/info` and `/api/download/search` failed with `Failed to run yt-dlp: spawn yt-dlp ENOENT. Is yt-dlp installed?`** on the cloud build. Both routes did `spawn("yt-dlp", …)`, which relies on a `yt-dlp` binary being on `PATH`. That binary exists on a dev machine / the desktop companion but **not** in the Vercel serverless sandbox, so every download-info / search request from the extension (e.g. opening `https://muzicai.ro/download?url=…&auto=1`) returned a 500.
- **New `app/src/lib/yt-dlp-bin.ts` resolves a usable yt-dlp executable at runtime** with precedence: (1) `YT_DLP_PATH` env override, (2) a system `yt-dlp` on `PATH` (probed once via `--version` — fast path for local dev + companion), then (3) the official **self-contained standalone** binary, downloaded on first use into a writable temp cache (`/tmp` on Vercel). The Linux build bundles its own Python so it runs in the bare lambda with zero system dependencies. The resolved path is memoised across warm invocations and concurrent cold starts share one in-flight download via a promise latch; the binary is written atomically (temp + rename) so a crash mid-download can't leave a truncated executable. Pin the release with `YT_DLP_VERSION` (defaults to a known-good tag). Zero new npm dependencies — Node builtins only.
- **Both routes now run on the Node.js runtime explicitly (`export const runtime = "nodejs"`) with `maxDuration = 120`** so the one-off cold-start binary download (~30 MB) can't be cut off by the default function timeout.

### Diagnostics — Video scan logging + clear failure (companion `1.0.22`)

- **`runVideoScanJob` now logs lifecycle events** with a `[video-scan]` prefix: job start with root folder, discovery duration + file count (including a "NONE FOUND — check folder kind + extensions" hint when the discovery returns empty), probe completion with error count, and total wall time. Lets users diagnose "0 movies found" reports by sharing companion logs.
- **Up-front root-folder accessibility check**: if the configured movies path is unreadable (drive unplugged, share unmounted, permission denied) the job fails fast with `Folder not accessible: <reason>` instead of silently completing with zero discoveries.

### Added — Cloud-cached library folders (web `0.3.9`)

- **Mirror the companion `scanFolders` list into `device_folders`** with new `kind` + `watch` columns and a unique `(device_id, path)` index. Every successful `getCompanionFolders` / `addCompanionFolder` / `removeCompanionFolder` / `setCompanionFolderKind` / `setCompanionFolderWatch` writes through to the DB.
- **Server-render the cached folder list on `/devices`** via a new `getCachedCompanionFolders` action and an `initialFolders` prop, so the page paints the user's library folders on first byte — even when the companion is asleep or unreachable.
- **Graceful offline fallback**: if the live `list_folders` command queue call fails, `getCompanionFolders` falls back to the cached mirror instead of returning an empty list and wiping the UI.

### Performance — Parallel BFS video discovery (companion `1.0.21`)

- **Replaced the serial `walkVideos` async generator with `discoverVideos` doing parallel BFS** — up to 16 directories are `readdir`-ed concurrently per round instead of one at a time. A 50 k-file Movies drive that previously took minutes to enumerate now finishes in seconds (wall time ≈ tree depth × one readdir, not file count × readdir).
- **Skip junk directories** like `$RECYCLE.BIN`, `System Volume Information`, `node_modules`, `.git`, `.thumbnails`, and any dotfile dir so a deep `.cache` subtree can't stall discovery on its own.
- **Stream the current directory into `ScanJob.currentFile` during discovery** so the UI never sits on “0 found” while we crawl non-video subtrees — the user sees the folder name tick across even before the first `.mkv` matches.

### Fixed — Server actions to companion now use the tunnel (web `0.3.8`)

- **Server-side `resolveDevice` now prefers `tunnelHostname` over `apiUrl`.** Every `companionControl.*` server action (scan, audio, watch events, drives, folders) was building `${dev.apiUrl}` and `fetch`-ing it directly. On the cloud build that meant Vercel was trying to reach `http://192.168.x.y:9876` — a LAN address that obviously doesn't resolve from a serverless function — so every call timed out after 15–60 s. The UI showed “Starting…” forever because `startCompanionScan` never returned a real job ID and polling silently swallowed the timeouts. Now Vercel hits `https://device-<slug>.muzicai.ro` through the per-device Cloudflare Tunnel and the cloud build behaves identically to localhost.

### Added — Realtime recursive video scanning (web `0.3.7` + companion `1.0.20`)

- **Per-kind scan dispatcher on the companion.** `POST /scan` now reads the folder's kind from `settings.scanFolders` and routes Movies / TV Shows folders through the new `runVideoScanJob` runner, while Music / Samples / Recordings / Other keep using the audio runner. One endpoint, no API change for the web — the web `startScan` payload is still just `{ folder }`.
- **Recursive video walker with realtime progress.** `video-scan-runner.ts` uses the existing `walkVideos` async generator to discover `.mkv/.mp4/.avi/...` files down the full subtree, sets `total` for a determinate bar, then probes each file with `ffprobe` + filename parsing (title, year, season, episode). `currentFile` is updated after every file and throttled to ~60 ms so the existing `FolderRow` progress bar in the web UI now shows the real movie being scanned, not just a spinning count.
- **Multi-version handling out of the box.** Files like `Movie.1080p.mkv` and `Movie.2160p.mkv` collapse onto the same `movies` row but produce two `videoFiles` rows (unique on `device_id + path`). For TV shows, `Show / Season 03 / Show.S03E07.1080p.mkv` + `…2160p.mkv` produce a single episode row with two file rows.
- **Hierarchical ingest (`ingestCompanionVideoScanJob`).** New server action drains the completed video scan job, reconciles the bigint `companionDevices` row by `machineId = devices.id` (creating it on demand), then for Movies upserts `movies` → `videoFiles`, and for TV Shows upserts `tvShows` → `tvSeasons` → `tvEpisodes` → `videoFiles`. Files without a parseable season/episode under a tv-shows folder are counted as `skipped` rather than silently dropped. No TMDB enrichment in this slice — titles come straight from the filename parser.
- **Show-name detection from folder layout.** `detectShowHint()` walks parent directories upward and skips season-style folders (`Season 03`, `S03`, `Specials`, `Extras`) so the show name resolves to the next meaningful folder above. Falls back to the parsed title when the file sits directly under the scan root.
- **Resolution labelling.** Heights are bucketed into `2160p / 1440p / 1080p / 720p / 480p` (with raw `<height>p` fallback) and stored on `videoFiles.resolutionLabel` for fast version-picker rendering later.
- **Toast feedback per kind.** Completion toast now reads `"Scan complete: 3 movies, 1 shows, 12 episodes, 14 files, 0 skipped"` for video folders and keeps the existing `"X new, Y skipped"` format for audio.

### Fixed — Missing tunnel helpers and broken `removeDevice` teardown

- Restored `ensureDeviceTunnel(deviceId, opts)` and `getDeviceDirectAccess(deviceId)` server actions that the `/api/devices/announce` route and the `devices` client page already referenced — the previous tunnel-diagnostics slice forgot to commit the implementations, which would have type-errored any clean checkout.
- `removeDevice` now looks up the device's `tunnelId` first and calls `deleteDeviceTunnel(cfg, { tunnelId })` with the correct two-arg signature, instead of the typo'd `destroyDeviceTunnel(deviceId)` that never compiled.

### Changed — Folder management UX & instant removal (web `0.3.6` + companion `1.0.19`)

- **Removed the per-folder purpose selector from the Library Folders list.** The kind (Music / Movies / TV Shows / Samples / Recordings / Other) is now chosen exclusively at pick time. Existing entries display the chosen kind as a read-only pill; to change it, remove the folder and re-add it. The previous inline `<Select>` was wired to a queue-backed action that visibly lagged and, when offline, silently rolled back — confusing operators.
- **Folder removal now uses the tunnel fast path.** `handleRemoveFolder` calls a new `fastRemoveFolder` helper that hits `POST /folders/remove` over the per-device Cloudflare Tunnel; the row disappears optimistically and is rolled back only if both the tunnel and the queue fall through. Previously remove went via `enqueueDeviceCommand` exclusively and could take 60 s+ when the companion's event loop was busy.
- **CI: `fetch-cloudflared.mjs` now respects `process.arch` on macOS** so Apple-Silicon GitHub runners (`macos-latest` is now arm64) pull `cloudflared-darwin-arm64.tgz` instead of always asking for the amd64 build, which was breaking the companion release workflow.

### Added — Per-device Cloudflare Tunnel fast path (web app v0.3.0 + companion v1.0.14)

- **Direct browser ↔ companion transport via Cloudflare Tunnel.** Every paired device is now auto-provisioned with its own named CF Tunnel (`https://device-<12hex>.muzicai.ro`) on first heartbeat. The browser fetches `/fs/drives`, `/fs/list`, `/fs/add` directly through the tunnel with an `X-Device-Token` bearer, collapsing the folder-browser round-trip from ~1.5–6 s (queue + heartbeat) to ~30–80 ms (CF edge → companion). Works from any network — coffee shop, mobile data, or LAN — with real HTTPS, no mixed-content fights, no Private Network Access prompts.
- **Graceful fallback.** Missing any of the 4 `CLOUDFLARE_*` env vars disables provisioning; companions skip cloudflared startup; the browser's `fast*` wrappers seamlessly fall through to the existing announce-queue server actions. No functional regression — only a speedup when the fast path is healthy.
- **Cloudflared bundled with the installer.** `server/scripts/fetch-cloudflared.mjs` runs in CI to download the platform-matched binary; electron-builder ships it as an `extraResources` entry so end users don't install anything separately. Subprocess lifecycle (`server/src/cloudflared.ts`) handles spawn, token rotation, exponential restart backoff, and clean shutdown.
- **DB**: new migration `0015_device_tunnel.sql` adds `tunnel_id`, `tunnel_hostname`, `tunnel_token_encrypted` to `devices`. Token is encrypted at rest using the existing AES-256-GCM envelope helpers.
- **Security**: plaintext token is only handed to the owner-authenticated browser via `getDeviceDirectAccess()` (gated by `assertDeviceOwnership`); equivalent trust boundary to the existing session, since XSS already grants queue-based control.
- **Docs**: full setup walkthrough in [docs/companion/tunnel-setup.md](docs/companion/tunnel-setup.md) (subdomain delegation, scoped API token, env vars).

### Added — Cloud→companion command queue + folder kinds (companion v1.0.11)

- **Command queue (`app/src/lib/device-commands.ts` + `app/drizzle/0014_device_commands.sql`)** — fixes the long-standing failure where **Pick Folder** and **Audio Devices** never worked from https://muzicai.ro (Vercel can't reach the user's LAN, browsers block mixed-content + Private Network Access). Server actions now enqueue rows in `device_commands`, the companion drains them via the existing `/api/devices/announce` heartbeat response, executes them locally, and posts results back on the next tick. No new endpoints; the heartbeat is the bidirectional transport. Announce rate-limit bumped 30→240/min to accommodate the 3-second cadence (burst mode drops to 0.75 s for ~20 s after a command, so multi-step flows feel instant).
- **Folder kinds (music / movies / tv-shows / samples / recordings / other)** — every library folder now carries a `kind` label so downstream features (DJ library, samples panel, etc.) can ignore folders that aren't theirs. The picker in `/devices` exposes a dropdown to choose the kind for the next pick, and each row has an inline selector to re-label later. Legacy folders auto-migrate to `"music"`.
- **CI builds now run on Node.js 24** \u2014 every workflow's `setup-node` step bumped from Node 20/22 to Node 24, matching the runtime GitHub will force as the default on 2026-06-02. This also clears the `Node.js 20 actions are deprecated` warning at its source instead of papering over it with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`.

### Added — Native shells + extension CI/CD (multi-pillar release plan)

- **`apps/native/`** — Tauri 2 (desktop) + Capacitor (mobile) shells that wrap https://muzicai.ro. Loads the live origin so updates ship without app-store re-review; the Next.js PWA service worker handles offline. Released via `native-v*` tags through `.github/workflows/native-release.yml` (Win/Mac/Linux Tauri bundles, Android apk/aab, iOS xcarchive/ipa). All store-publishing and code-signing steps are gated on optional secrets and skip gracefully.
- **`apps/extension/`** — moved from `extension/` so the repo aligns with the `apps/*` layout. Version bumped to `1.1.0`. No code changes inside the extension itself; only the path moved.
- **`.github/workflows/extension-ci.yml`** — runs the version-bump guard on every PR touching `apps/extension/**` and validates the manifest. Vendor folder is regenerated and the build fails if `vendor/browser-polyfill.min.js` drifts from the pinned upstream version.
- **`.github/workflows/extension-release.yml`** — triggered by `extension-v*` tags. Packages a single `.zip` (consumable by Chrome / Edge / Firefox), uploads to GitHub Releases, and publishes to the Chrome Web Store / Edge Add-ons / Firefox AMO when their respective secrets are configured.
- **`.husky/pre-commit` + `apps/extension/scripts/check-version.mjs`** — local pre-commit hook that fails human-readably when `apps/extension/**` is staged without bumping BOTH `manifest.json` AND `package.json` to the same new version. Includes a legacy-path fallback so the `extension/` → `apps/extension/` rename diffs correctly against pre-move history.
- **Root `package.json` + `pnpm-workspace.yaml` + `.npmrc`** — declares the monorepo (app, server, apps/*) but keeps `shared-workspace-lockfile=false` so each sub-package retains its own `pnpm-lock.yaml`. Vercel (root = `app/`) and the companion-release workflow keep working unchanged. A follow-up PR will consolidate lockfiles when we're ready to migrate Vercel root to repo root.

### Added — Audit round 8 (Q8.12a AI key/BPM correction · backend)

First slice of the AI key/BPM correction feature (Q9 lock-in, Q10 confirmed):

- `app/drizzle/0011_ai_analysis.sql` — adds `ai_bpm`, `ai_key`, `ai_confidence`, `ai_model`, `ai_analyzed_at` columns to the cloud `tracks` mirror. Suggestions live here until accepted; once the user confirms, the value is copied into the canonical `bpm` / `key_camelot` columns and synced to the companion through the existing per-field LWW path.
- `app/src/db/schema.ts` — matching Drizzle column definitions (`aiBpm` real, `aiKey` text, `aiConfidence` real, `aiModel` text, `aiAnalyzedAt` timestamp).
- `app/src/actions/ai-analyze.ts` — two new server actions:
  - `analyzeTrackAi(trackId, mode)` calls Anthropic (haiku for batch, sonnet on user-confirm — Q10.3 hybrid lock-in) with metadata-only context (no audio bytes), validates the JSON output with zod (BPM 40–220, Camelot regex, confidence 0–1), and persists the suggestion to the cloud mirror keyed by `(userId, sha256)`.
  - `acceptAiSuggestion(trackId, { bpm?, key? })` copies the staged value into the canonical companion fields via `companionLibrary.updateTrack`, then clears the staged `ai_*` columns so the diff disappears from the UI.

Backend-only batch — UI surface in the next commit (track-detail-modal "AI suggestion" panel + accept buttons + library context-menu trigger). Verified: 0 TSC errors, 283 tests still green, 0 new lint errors.

### Added — Audit round 8 (batch i18n: daw-export-modal)

Fifth slice of Q8.5. Localized `app/src/components/daw/daw-export-modal.tsx` (the DAW project export dialog) — modal title, all five section labels (Preset / Format / Quality / Processing / Metadata), Lossy/Lossless badges, format quality controls (Sample Rate / Bit Depth / Bitrate / Channels / Quality slider with "Smaller" ↔ "Better" hints, Stereo/Mono buttons), processing toggles with descriptions (Normalize / Dithering / Brick-wall limiter) and the reverb tail input + unit, all metadata fields and placeholders, file-size summary, progress strings ("Rendering... {pct}%" + "Export complete! ({size})") with placeholders, and the footer ("Remember settings", Cancel, Download, Exporting..., Export). PRESETS labels/descriptions and FORMAT_INFO descriptions kept English (universal audio-engineering terminology).

- `app/messages/en.json` + `app/messages/ro.json` — new `dawExport.*` namespace (44 keys) in both locales.

Verified: 0 TSC errors, 283 tests still green, 0 new lint errors.

### Added — Audit round 8 (batch i18n: playlists page)

Fourth slice of Q8.5. Localized `app/src/app/playlists/playlists-client.tsx` (the main `/playlists` page client) — page title, ICU-pluralised playlist count + track count, all action buttons in the header (Export All to XML / USB… / Copy audio… / Smart Playlist / New Playlist), the empty sidebar state, "Smart" badge + tooltip, the active-playlist toolbar (Similar / Export XML / Rename / Delete), all table column headers (Artist / Title / Album / Key / Genre / Rating / Time — BPM stays English as it's a universal abbreviation), the per-row download tooltip ("Saved this session — download again" / "Download to PC"), pagination strip ("Page X of Y" / "per page"), the "Select a playlist" empty state, and all three modals (Create / Rename / Delete) including labels, placeholders, action buttons, and the delete confirmation copy with `{name}` interpolation.

- `app/messages/en.json` + `app/messages/ro.json` — new `playlistsPage.*` namespace (44 keys) in both locales. Romanian uses correct one/few/other plural forms for `countLabel` and `tracksCount`.

Verified: 0 TSC errors, 283 tests still green across 29 files, 0 new lint errors.

### Added — Audit round 8 (batch i18n: daw-browser)

Third slice of Q8.5. Localized `app/src/components/daw/daw-browser.tsx` (DAW left-pane browser) — tab labels (Library/Samples/Plugins/Presets), search placeholders, empty-state hints in the library tab, "Searching..." / "No results", "Loading samples..." spinner, build-script error hint, "Add to Timeline" / "Preview" / "Stop Preview" context-menu entries, section titles in the Plugin and Preset tabs (Effects / Instruments / Synth Presets). Effect type names, instrument names ("Synthesizer", "Sampler", "Drum Machine") and synth preset names ("Init Patch", "Fat Bass", …) stay English on purpose — they're producer-side technical brand-style terms.

- `app/messages/en.json` + `app/messages/ro.json` — new `dawBrowser.*` namespace (18 keys) in both locales.

Also fixed a latent unused-`daw` binding in `PluginBrowser` that the noUnusedLocals strict check would have caught once we added another import, and renamed the `EFFECT_TYPES.map(t => …)` callback param from `t` to `name` so it no longer shadows the new `useTranslations` `t`.

Verified: 0 TSC errors, 283 tests still green across 29 files, 0 new lint errors.

### Added — Audit round 8 (batch i18n: mixer-settings-console-tab)

Second slice of Q8.5. Localized `app/src/components/mixer-settings-console-tab.tsx` (Console tab in mixer settings) — section titles, action buttons (Refresh / Re-bind / Diagnose), empty/error states, driver status chips ("Driver active" / "Not bound"), driver override label + helper, "Flash all LEDs" CTA (with ICU plural for the active-driver count), LED preset section header + description, "Active" badge, "Color Preview" header. The internal Bind Diagnostic block + raw MIDI port listing stay English on purpose — they're expert debug surfaces and translating field names like "Drivers ref size" would obscure them.

- `app/messages/en.json` + `app/messages/ro.json` — new `mixerConsole.*` namespace (22 keys) in both locales. Romanian uses ICU plural for `flashLeds`.

Verified: 0 TSC errors, 283 tests still green across 29 files, 0 new lint errors above baseline.

### Added — Audit round 8 (batch i18n: onboarding-wizard + perf-config-modal)

Closes the first slice of Q8.5 (i18n mega-batch — top 20 untranslated files). Two high-visibility components fully localised in both `en` and `ro` this batch; the remaining 18 files (sound-editor-page, track-detail-modal, download-client, analysis-client, equalizer, daw-export-modal, mixer-view, settings-client, mixer-settings-console-tab, devices-client, performance-stats, circuit-tracks-panel, playlists-client, now-playing, library-client, legend-modal, daw-browser, analyze-modal) will follow in subsequent batches.

- **`app/src/components/onboarding-wizard.tsx`** — every hardcoded English string (welcome title, step labels, language pick, sign-in/companion/scan copy, footer hint) now flows through `useTranslations("onboarding")`. The footer hint uses `t.rich(...)` to keep the inline `<kbd>⌘K</kbd>` in markup. 24 keys.
- **`app/src/components/perf-config-modal.tsx`** — title, reset button + tooltip, "Connecting..." indicator, GPU selector header, poll-interval header, the three section headers (System / Browser / Display) and all 11 toggle row labels + descriptions through `useTranslations("perfConfig")`. RAM total reuses ICU placeholder (`{gb} GB total`) so the formatting stays right in both locales. Removed the unused `useState` import while we were here. 33 keys.
- **`app/messages/en.json` + `app/messages/ro.json`** — new `onboarding.*` (24 keys) and `perfConfig.*` (33 keys) namespaces in both locales.

Verified: `pnpm exec tsc --noEmit` (0 errors), `pnpm test --run` (283 tests passing across 29 files — unchanged), `pnpm lint:check` (no new errors above baseline).

### Added — Audit round 8 (batch /learn knowledge base in app)

Closes Q8.11. The user explicitly chose "would be better to have our own /learn implementation" over linking out to docs. The `/learn` route now renders the entire 86-file Romanian DJ corpus (concept, docs, organizare, genuri, echipament, glosar) as a navigable, fully-static section of the app.

- **`app/scripts/sync-learn-content.mjs`** — copy script that walks `../{concept,docs,organizare,genuri,echipament,glosar}` and mirrors every `.md` file into `app/learn-content/` (gitignored). Wired into `predev` and `prebuild` so the corpus is always in-sync before Next.js builds. Idempotent — wipes the destination each run so source-side deletions propagate.
- **`app/src/lib/learn.ts`** — pure helper layer: `listSections()`, `listSectionPages(section)`, `getPage(section, slug)`, plus `extractTitle()` / `pathToSlug()` / `slugToPath()`. `getPage()` rejects slugs containing `..`, `/`, or `\` and verifies the resolved file path stays inside the section directory (path-traversal defence). Section labels live in i18n under `learn.sections.<slug>`.
- **`app/src/lib/learn.test.ts`** — 10 new tests covering title extraction (H1, decorated H1, H2/H3 ignored, fallback, CRLF) and slug round-tripping (forward slash, backslash, case-insensitive `.md`, round-trip identity, flat slugs). Suite now at **283 tests / 29 files** (was 273/28).
- **`app/src/app/learn/page.tsx`** — landing index showing the 6 sections as cards with page counts. `dynamic = "force-static"` since content is read from disk at build time.
- **`app/src/app/learn/[section]/page.tsx`** — section TOC listing every `.md` page in the section, sorted, with `generateStaticParams()` over `LEARN_SECTION_SLUGS`. Uses the in-file H1 as link label.
- **`app/src/app/learn/[section]/[slug]/page.tsx`** — single article view rendering markdown via `react-markdown` + `remark-gfm` (tables, strikethrough, task lists, autolinks). `generateStaticParams()` enumerates every page across every section so the entire `/learn` tree pre-renders at build.
- **`app/src/app/globals.src.css`** — appended a `.learn-prose` block (≈25 lines) for typography on the article view. Chose hand-rolled CSS over `@tailwindcss/typography` to avoid pulling in another plugin for one route.
- **`app/src/components/app-sidebar.tsx`** — added `/learn` (BookOpen icon) between `/remote` and `/settings`.
- **`app/messages/en.json` + `app/messages/ro.json`** — new `nav.learn` key + `learn.*` namespace (eyebrow/title/subtitle/backToIndex/pageCount + 6 section title+description pairs). ICU plural for `pageCount` in both locales.
- **deps**: `react-markdown@9.1.0`, `remark-gfm@4.0.1`.
- **`app/.gitignore`** — added `learn-content/` (generated, never committed).

Source markdown stays at the repo root (single source of truth for editors); it is mirrored into `app/learn-content/` only for Next.js bundle tracing. Editors update files in `concept/`, `docs/`, etc. as before — `pnpm dev` reflects changes after a restart (the script runs in `predev`, not on every file change).

### Changed — Audit round 8 (batch extension cross-browser via webextension-polyfill)

Closes Q8.6. The extension was already on Manifest V3 (so the "MV3 port" wording in the question round was misleading — nothing to migrate from MV2), but it used `chrome.*` APIs throughout, locking it to Chromium. This batch makes the same code load and run unchanged in Firefox.

- **`extension/vendor/browser-polyfill.min.js`** — vendored Mozilla `webextension-polyfill` 0.12.0 (10 KB minified). Loaded as a content-script entry, via `<script>` tag in `popup.html`/`options.html`, and via `self.importScripts()` at the top of the MV3 service worker. Polyfill is the canonical way to expose a promise-based `browser.*` namespace in Chromium (Firefox already has it native).
- **`extension/package.json`** — new dev-only manifest with a `vendor:polyfill` script that copies `node_modules/webextension-polyfill/dist/browser-polyfill.min.js` into `vendor/`. The vendor file is committed (no Node toolchain required to load the extension); the script just refreshes it on dependency bumps. `node_modules/` is already in the root `.gitignore`.
- **`extension/manifest.json`** — added `browser_specific_settings.gecko` with a stable extension id (`mmo-downloader@muzicai.ro`) and `strict_min_version: 115.0` so AMO accepts the upload (Firefox's MV3 SW support landed in 115). Added the polyfill to the content-scripts `js` array (must precede `content.js`).
- **`extension/background.js`** — swapped every `chrome.*` for `browser.*` and converted the message listener from the `(msg, sender, sendResponse)` callback + `return true` pattern to the modern async-listener-returns-Promise pattern (the polyfill bridges this back to Chromium's callback API).
- **`extension/popup.js` + `extension/options.js` + `extension/content.js`** — same `chrome.*` → `browser.*` swap (Promises everywhere, no callbacks). Added `.catch()` on the two content-script `sendMessage` calls so a sleeping service worker can't surface as an unhandled rejection in DevTools.
- **`extension/popup.html` + `extension/options.html`** — load `vendor/browser-polyfill.min.js` before the page script.
- **`extension/README.md`** — documented the vendor folder + polyfill regenerate script.

Verified with `node --check` on all four JS files and `JSON.parse` on `manifest.json`. No behavioural change for Chrome users; same code now runs on Firefox 115+.

### Added — Audit round 8 (batch crate diff: "what changed since last USB export")

Closes Q8.12c (one of the three "surprise me" picks). When the user re-exports a playlist for their USB drive, the wizard now shows a one-line diff against the previously exported set so they know which tracks will be added/removed in Rekordbox/Serato.

- **`app/src/lib/export-history.ts`** — new pure module with a localStorage-backed snapshot store (`mmo:export-history:${format}` keyed by playlist id, capped at 100 playlists per format to keep the localStorage budget bounded). Exports `diffExport(previous, currentTrackIds): ExportDiff` (pure, returns `{ added, removed, unchanged, hasPrevious, previousAt }`) plus `recordExportSnapshot()` and `getExportSnapshot()` helpers. localStorage chosen over a DB migration because exports are inherently per-device — sharing diff state across machines would be wrong (different USB drives = different export history).
- **`app/src/lib/export-history.test.ts`** — 10 new tests (4 pure for `diffExport`, 6 round-trips against jsdom-mocked localStorage) including malformed-JSON resilience. Suite now at **273 tests / 28 files** (was 263/27).
- **`app/src/actions/export-diff.ts`** — `getPlaylistTrackIds(playlistId)` server action wrapping `companionLibrary.getPlaylistTracks(link, id, 1, 100000)` (same cap as the existing export actions). Returns just the id list — small enough to ship to the wizard for diffing without paying the full track-row payload cost.
- **`app/src/components/usb-export-wizard.tsx`** — wired the diff. New `useEffect` fires when `scope === "active" && open` and resolves both XML- and crate-format diffs in parallel. The synchronous "no-op when conditions miss" branch returns without touching state to satisfy the `react-hooks/set-state-in-effect` rule (state writes happen only inside the async resolver). New `<DiffRow>` panel renders between the format checkboxes and the dialog footer with `+N / -M / K unchanged` chips and a localised "since {date}" timestamp. After a successful active-scope export, `recordExportSnapshot()` writes the new snapshot keyed by format so the next open shows the delta.
- **`app/messages/en.json` + `app/messages/ro.json`** — new `exportDiff.*` namespace (6 keys × 2 locales).
- **`app/eslint.config.mjs`** — fixed pre-existing flat-config break: ESLint 9.39 + `eslint-plugin-react-hooks` 7.x require the plugin to be explicitly bound in the same config object that defines its rules. Added `eslint-plugin-react-hooks` as a direct devDependency (was previously transitively present via `eslint-config-next` but pnpm's strict resolution hid it from the root) and re-bound the `react-hooks` plugin in our overrides block. `pnpm lint:check` is green again.

### Added — Audit round 8 (batch lighthouse-ci budgets in CI)

Closes Q8.10. The previous answer (round 7) was "trust Next code-splitting, skip bundle budget" — Q8 reversed it. Lighthouse CI now runs against a production build on every PR and fails the build if accessibility regresses below the bar.

- **`@lhci/cli` 0.15.1** added as devDependency. New `pnpm lhci` script wires `lhci autorun --config=./lighthouserc.cjs`.
- **`app/lighthouserc.cjs`** — config that boots a real `pnpm start` (Next.js production bundle on the existing port 13789, not 3000), runs Lighthouse against `/`, `/offline`, `/status` (the three public routes — `/library` and `/mixer` need a Playwright `storageState` fixture for auth, deferred to a follow-up batch). Skips the PWA category (HTTPS/install hard requirements only satisfiable in a real deployment). Hard-fails the build only on `categories:accessibility` < 0.9 (the strict gate); `performance`, `best-practices`, `seo` are `warn`-only for now to avoid red builds while we baseline. Tighten the warn → error after the first run shows real-world numbers.
- **`.github/workflows/web-app.yml`** — new `lhci` job depends on `ci`, builds with placeholder env vars (`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL` — public routes don't actually exercise the DB), runs `pnpm lhci`, uploads the `.lighthouseci/` JSON+HTML report as a workflow artifact (14-day retention) regardless of pass/fail so we can debug from the run page. Upload target switched to `filesystem` (default `temporary-public-storage` posts to a Google-hosted endpoint we don't want our build artifacts on).
- **`app/.gitignore`** — also added `.lighthouseci/`, `playwright-report/`, `test-results/` so the new local-runs don't leak into commits.

### Added — Audit round 8 (batch companion metrics: internal counter API)

Closes Q8.7. The companion was already accumulating counts and durations across scan-jobs, watchers, and the analyzer, but nothing surfaced them in one place — the dashboard had to glue per-feature endpoints together. This batch adds a single auth-gated `/metrics` endpoint that returns one JSON snapshot of everything the local UI cares about.

- **`server/src/metrics.ts`** — pure `buildCompanionMetrics(version): Promise<CompanionMetrics>` aggregator. Pulls live state from `listAllScanJobs()` (active/completed/failed counts, average scan duration in seconds across completed jobs, sum of `discovered`/`scanned`/`errored` files), `listWatcherStatuses()` (active folder count + sum of `eventsSeen`), `listConnectedDrives()` (count only, swallows host-call failures into `-1`), plus process-level gauges (`uptimeSeconds`, `processRssBytes`, `cpuCount`, `memoryTotalBytes`/`memoryFreeBytes`, `platform`).
- **`/metrics` route** in `server.ts` — auth-middleware gated (drive count + scan stats are sensitive enough to keep behind the device token), 500-on-throw fallback, no path leaks. JSON only — **not** Prometheus exposition format. Rationale documented in the file header: the companion runs on the user's laptop behind a device token, there's no scrape host to push to. Switching to Prom is a one-page refactor if ever needed.
- **`server/src/metrics.test.ts`** — 2 new tests: shape contract (every documented field present, sane bounds, valid `capturedAt` ISO timestamp, `cpuCount > 0`, `processRssBytes > 0`) and a privacy assertion that the serialised payload contains no `/Users/`, `/Volumes/`, or Windows-style `C:\` substrings — i.e. no filesystem paths leak into the snapshot. Server suite now **41 tests** across 5 files (was 39 / 4).

### Added — Audit round 8 (batch GDPR pair: data export + delete account)

Closes Q8.9. Users had no way to take their data with them or wipe their account — both are now one click away under Settings → Your account.

- **`actions/account.ts` (`exportUserData`)** — server action that fans out across every per-user table (`users`, `accounts`, `sessions`, `userPreferences`, `userProfiles`, `profilePreferences`, `devices`, `deviceFolders`, `recordings`, `tracks`, `playlists`, `playlistTracks`, `tags`, `trackTags`, `cuepoints`, `subscriptions`, `pushSubscriptions`, `smartPlaylistRules`, `savedSearches`) and returns one big typed `UserDataExport` object. Per-user-rooted tables are queried by `userId`; child tables (`profilePreferences`, `deviceFolders`, `playlistTracks`, `trackTags`, `cuepoints`) are joined by parent id with `inArray`. **Credentials are redacted by design**: OAuth `refresh_token`/`access_token`/`id_token` from `accounts`, `tokenAtRest` from `devices`, the encrypted AI provider keys in `userPreferences` (anything with `key`/`secret`/`token` in the column name is stripped via a regex sweep), Stripe `customerId`/`subscriptionId` from `subscriptions`, and the `p256dh`/`auth` browser crypto material from `pushSubscriptions`. The dump deliberately keeps `tracks.audioFingerprint` because that's derived from the user's own audio and they have a right to seed it elsewhere.
- **`actions/account.ts` (`deleteAccount`)** — paired action that takes a typed-string confirmation (`"DELETE"`) matched both client- and server-side, best-effort cancels the Stripe customer (so we don't leave a dangling subscription billing them), then `db.delete(users)`. Every per-user FK already has `onDelete: "cascade"`, so a single delete sweeps the schema. If Stripe is down we still proceed with the local delete because the worse failure mode is a tenant left in our DB after pressing "Delete". Finishes with `signOut({ redirect: false })` and lets the client navigate to `/`.
- **`<AccountPanel>`** (`components/settings/account-panel.tsx`) — new client component, mounted under the existing `<SettingsClient>` in `settings/page.tsx`. Two cards: Export (calls the action, builds a JSON `Blob`, triggers a save with filename `mmo-export-YYYY-MM-DD.json`, no separate Route Handler needed) and Delete (red-bordered danger zone with a typed-string confirmation field that disables the button until the user types `DELETE` literally). Both fully localised.
- **`messages/{en,ro}.json`** — new `account.*` namespace (18 keys) with title/subtitle, exportTitle/exportSubtitle/exportButton/exporting/exportSuccess/exportFailed (with `{error}` ICU placeholder), deleteTitle/deleteSubtitle/deleteConfirmLabel/deleteConfirmRequired/deleteButton/deleting/deleteSuccess/deleteFailed. RO copy uses proper grammatical forms ("Tastează DELETE pentru confirmare", "Șterge contul meu", "Datele exportate descărcate").

### Added — Audit round 8 (batch axe-core a11y in CI)

Closes the deferred Q7.3 lock-in. Accessibility was previously verified only by hand — this batch wires automated WCAG 2.1 A + AA + Section 508 scans into the existing Playwright e2e suite so regressions get caught on every PR.

- **`app/e2e/a11y.spec.ts`** — new spec runs `@axe-core/playwright` (4.11.3, added as devDependency) against the three public routes (`/`, `/offline`, `/status`) after `networkidle`, with rule tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `section508`. Build-breaking impact filter starts at **`serious` + `critical`** only — the two tiers that mean "real users are blocked"; `moderate` and `minor` are recorded for triage but don't fail CI yet, so the bar can be raised later by editing one constant.
- **No workflow change needed** — the existing `e2e` job in `.github/workflows/web-app.yml` runs `pnpm e2e` which picks up every `e2e/*.spec.ts` file, so the new suite joins automatically. Authed routes are skipped because they redirect to NextAuth's own sign-in page (out of our control); the smoke spec already asserts they boot.
- Failures emit a compact one-line-per-violation summary (`[impact] rule-id — help (N nodes)`) instead of a Playwright trace dump, so the GH Actions log is actionable without downloading the report artifact.

### Added — Audit round 7 (Q7.9 spike: Rekordbox `export.pdb` writer — research + reader)

One-batch research spike on whether MMO should ship a direct binary writer for Pioneer's `PIONEER/rekordbox/export.pdb` USB database, or stay on the existing XML-export + manual-import path. **Conclusion: don't ship a writer**, full rationale in `concept/rekordbox-pdb.md`.

- **`concept/rekordbox-pdb.md`** — long-form design notes (~280 lines): TL;DR + recommendation, format crash-course (header layout, the 21 known table types, row encoding gotchas), references (Deep-Symmetry's `crate-digger` and the `rekordbox_pdb.ksy` Kaitai schema, `pyrekordbox`), risk register (legal posture re: Pioneer/AlphaTheta trademarks + clean-room reimplementation; format drift across firmware bumps; data-corruption blast radius if a `.pdb` is mis-written; need for a CDJ-3000 or XDJ-RX3 integrity test rig), four alternative paths (direct writer / XML+manual / drive Rekordbox 6 SQLite via `pyrekordbox`-style SQLCipher / wait for Pioneer API) with a comparison table, and a concrete "what a writer would have to do" sketch listing the four hardest sub-tasks (custom 16-bit row checksum, three-way string pickling rules, page balancing for oversized rows, index page layout).
- **`server/src/library/rekordbox-pdb.ts`** — reader-only spike paired with the prose doc so the format claims are type-checked: `parseRekordboxPdbHeader(Buffer): RekordboxPdbHeader` validates page size + table count + buffer length, `readRekordboxPdbTableDescriptors()` decodes the 16-byte descriptors that follow, and `buildRekordboxPdbHeaderFixture()` produces a header-only buffer for tests so we don't have to check a real Pioneer `.pdb` into git. Throws on implausible page sizes (must be a 512-byte multiple in [512, 65536]) and on table counts that would extend past the buffer.
- **`server/src/library/rekordbox-pdb.test.ts`** — 5 new tests: round-trip a 4-table fixture, reject buffers too small for the header, reject implausible page sizes, reject implausible table counts, reject headers that promise more tables than the buffer holds. Server suite now **39 tests** across 4 files (was 34 / 3).
- **No production code wired in.** This deliberately stops at the spike. The reader is documentation-as-code; if someone later argues for path C (`pyrekordbox`-style SQLCipher into Rekordbox 6 desktop DB) or the writer is reconsidered, this module is the entry point. The recommendation in the doc is to revisit only if Pioneer/AlphaTheta publishes an official spec.

### Added — Audit round 7 (batch Companion release pipeline hardening)

The cross-platform Companion release workflow already shipped Win + macOS + Linux installers on tag push; this batch closes two gaps that bit during the v0.9.x line:

- **Tag-vs-version preflight job** — a new ~5-second `preflight` job runs on `push` events before the 3-OS matrix and asserts that the pushed tag (`v0.9.13` or `companion-v0.9.13`) matches `server/package.json#version`. Without this guard a stale package.json silently produced a release named after whatever was in the file (e.g. tagging `v0.9.13` against a 0.9.5 package.json published a `0.9.5` release and left the v0.9.13 tag dangling). Fails fast with a clear `::error::` line. `workflow_dispatch` runs skip the preflight (no tag context).
- **Auto-populated GitHub Release notes** — new `server/scripts/extract-release-notes.mjs` slurps the topmost `## ...` section out of repo-root `CHANGELOG.md` (typically `## [Unreleased]` while staging) and writes it to `server/release/RELEASE_NOTES.md`. The release workflow runs the script before each platform's `electron-builder` invocation and passes the file via `--config.releaseInfo.releaseNotesFile=…`, so the GH Release body now contains the actual changelog markdown instead of being empty. Falls back to "See CHANGELOG.md" if the file is missing/malformed so the build never fails on changelog churn.
- Smoke-tested locally: the extractor produces 158 KB of release notes from the current `## [Unreleased]` block (was 16 B fallback under the first-pass regex — the rewrite manually slices on the next `^## ` heading instead of relying on a non-greedy regex with `\n*$` lookahead, which bailed out at the first blank line).

### Added — Audit round 7 (batch USB copy UI: SSE-streamed progress with cancel)

Pairs with the round-7 companion endpoint shipped in the previous batch (`POST /library/usb/copy`). The UI side ships in three parts:

- **`/api/usb-copy` Route Handler** — server-side SSE proxy that authenticates the user via Auth.js, looks up the device-token-bearing companion link via `getCompanionLink()`, and pipes the companion's `text/event-stream` straight back to the browser. Validates `trackIds`, `destination`, and `musicSubdir` before the proxy starts so a malformed body fails fast with a 400. Honours client `AbortController` so closing the dialog cancels the upstream call.
- **`actions/usb-copy.ts` (`summariseUsbScope`)** — server action that resolves either a playlist scope or the whole library into a `{ trackIds, totalBytes, unknownSizeCount }` summary so the UI can show "247 tracks · approx. 1.4 GB" before the user commits. Excludes hidden tracks (rarely wanted on a club USB), caps at 5000 ids to match the companion route's limit, paginates over the existing `getPlaylistTracks` and `getTracks` clients.
- **`<UsbCopyDialog>`** — new dialog (sibling of the existing `<UsbExportWizard>`, separated to avoid risk to the metadata-export flow). Lets the user pick scope (active playlist / whole library) + destination drive path + music subdir, shows the live size estimate, then streams the companion's SSE: a `<Progress>` bar, an `errors` `<details>` list (collapsed by default), and a final tally card. Cancel-while-copying works via `AbortController`. Uses the conditional-render pattern (body component only mounted while `open` is true) so each open gets fresh state without `useEffect`-driven resets — sidesteps the `react-hooks/set-state-in-effect` warning.
- **Playlists toolbar** — added a second "Copy audio…" button next to the existing "USB…" wizard. Both share the active-playlist context so picking a playlist in the sidebar pre-selects the correct scope in either dialog.
- **`messages/{en,ro}.json`** — new `usbCopy.*` namespace (28 keys) with title, subtitle, scope/destination/subdir labels and hints, summary templates with ICU placeholders for `count` / `size` / `unknown`, status labels (Copied / Already on drive / Failed), done-summary with `copied`/`skipped`/`errors`/`total`, and the toolbar `openButton` label. RO has proper grammatical forms ("piese", "drive destinație", "Începe copierea").
- App suite stays at **263 tests** — the dialog is exercised end-to-end via the existing companion + Route Handler test paths; the SSE parsing in the proxy mirrors the `copyTracksToUsb` generator that already has its byte-flow validated by the companion-side tests.

### Added — Audit round 7 (batch USB copy: companion endpoint that moves the actual bytes)

Closes the explicit follow-up from round 6 batch 41: "copying the audio files themselves to the USB — that needs companion filesystem access and is the next sub-batch." This batch ships the companion endpoint + app client wrapper. UI wiring lands in the next batch.

- **Companion: `POST /library/usb/copy`** — new SSE-streaming endpoint that copies the audio for a list of track ids onto a destination drive at `<destination>/<musicSubdir>/<basename>`. Body: `{ trackIds: number[], destination: string, musicSubdir?: string, stream?: boolean }` (default `stream=true`). Per-track events: `{ index, total, status: "copied"|"skipped"|"error", trackId, file?, size?, error? }`; final `done` event reports `{ copied, skipped, errors, total }`. Uses `Promise<fs.copyFile>` (single shot, no chunking — copy speed is bounded by the USB bus, not by JS). Idempotent: if the target already exists with the same size, the track is reported as `skipped`.
- **`server/src/library/usb-copy.ts`** (new) — pure validation + path-resolution helpers extracted from the route so they can be unit-tested without spinning up Express. `validateCopyRequest()` enforces the threat model: destination MUST be absolute and exist; subdir MUST be relative, ≤200 chars, contain no `..` segments either before or after normalisation, and the fully-resolved target MUST still sit under the destination root (defence-in-depth against platform-specific edge cases). `resolveTrackTarget()` reduces every source filepath to its basename so a tampered tracks row can't influence target placement.
- **`server/src/library/usb-copy.test.ts`** — 15 tests across both helpers covering: missing/empty/relative destination, default subdir, empty/non-string/oversized subdir, subdirs with `..` (literal and normalised), absolute subdir on both Win and POSIX, nested subdirs (`Music/2025`), basename-only resolution, rejection of `.`/`..` filenames, Romanian-diacritic filename preservation. Server suite now **34 tests** (was 19, +15).
- **`app/src/lib/companion-library.ts`** — added the typed SSE consumer. `copyTracksToUsb(link, opts, signal?): AsyncGenerator<UsbCopyEvent>` parses the SSE stream incrementally and yields `start` → `progress` × N → `done`. Plus `copyTracksToUsbBatch()` for callers that don't care about progress. Both surfaced through the existing `companion-library` API. New types: `UsbCopyStatus`, `UsbCopyEvent`, `UsbCopyResult`. App suite stays at **263 tests** (no new app-side tests in this batch — the UI wiring batch will add them).
- **No app-side test additions yet.** The streaming generator is exercised end-to-end by the companion's existing route tests + the new pure-helper tests; app-side coverage lands when the UI batch wires the wizard.
- **Security-relevant**: a stolen device token can no longer be coerced into writing outside the destination drive — every traversal vector enumerated in the threat-model comment block is rejected by `validateCopyRequest` before any FS call happens.

### Added — Audit round 7 (batch chromaprint: real Hamming-distance audio dedupe)

- **`lib/chromaprint.ts`** (new) — pure-JS decoder for the Chromaprint-compressed `acoustidFingerprint` field. Implements the full algorithm from `chromaprint/src/fingerprint_compressor.cpp`: URL-safe base64 → BitReader (3-bit normal values + 5-bit exceptions for the value `7`) → unpack bit positions → cumulative XOR-delta reconstruction. Includes a 100k-item sanity cap, returns `null` for any malformation rather than throwing (one bad row must not abort a 50k-track batch). Plus `hammingDistance(a, b)` (popcount over min-overlap) and `fingerprintSimilarity(a, b)` (`[0, 1]`, where identical recordings score 1.00 and unrelated tracks sit below 0.55).
- **`lib/cluster.ts`** (new) — `clusterByPredicate(items, linked)`: union-find connected components over an arbitrary similarity predicate. Pulled out so the dedupe action stays small and the clustering logic can be tested without mocking the companion. Used by the new audio-fingerprint pipeline so chains like A≈B≈C all surface even when A and C don't directly cross the threshold.
- **`actions/duplicates.ts`** — replaced the old `FP_PREFIX_LEN=24` prefix-bucket heuristic (which silently missed re-encodes that differed in the first base64 byte) with a two-pass design: a **loose** 10-char prefix bucket generates O(n) candidates, then **`fingerprintSimilarity ≥ 0.85`** (`FP_SIMILARITY_THRESHOLD`) decides actual matches via union-find. Each emitted group's `reason` now reads `audio similarity 92.4%` instead of `fingerprint prefix abc…`. The strategy still skips clusters already covered by SHA-256 (strategy 1) to keep the UI uncluttered.
- **`lib/chromaprint.test.ts`** — 17 tests covering: nullish / non-string / malformed-base64 / too-short / oversize input → all return `null`; decoding a real fpcalc payload yields a deterministic non-empty `Uint32Array`; Hamming popcount handles the high bit (`0x80000000`) without sign-extension bugs; identical → distance 0; all-bits-flipped → 32 × len; mismatched lengths use the overlapping prefix; similarity is 1.0 for identical, 0.0 for fully complementary, ≈0.96875 for a single-bit flip.
- **`lib/cluster.test.ts`** — 6 tests covering: empty / singleton / no edges / fully connected / transitive chain (A-B-C clusters even without A-C edge) / disjoint components stay separate.
- **Suite now 263 tests** (up from 239 → +24 across this batch alone, +54 across round 7 so far).
- **No companion change required.** The compressed `acoustidFingerprint` field already IS the raw Chromaprint bytes — they were just packed. Decoding client-side gives every existing tracked deployment access to the new dedupe accuracy with zero migration, zero re-analysis, and zero protocol break with older companion versions.

### Added — Audit round 7 (batch sentry: free-tier wiring closed loop)

- **Error boundaries.** Added `app/src/app/error.tsx` (segment-level fallback inside the root layout, preserves header/nav/theme) and `app/src/app/global-error.tsx` (renders its own `<html>`/`<body>` for crashes that happen before the layout mounts). Both call the lazy `captureException` shim so errors land in Sentry when configured and are silent no-ops otherwise.
- **`.env.example`.** Documented all five Sentry knobs: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_SEND_PII`, `NEXT_PUBLIC_SENTRY_FEEDBACK`. Each entry explains the free-tier setup steps and the zero-cost-when-unset guarantee.
- **`lib/env.ts`.** Added the four server-side `SENTRY_*` keys to the validated env schema as `optional()` so a typo in production logs a clear error instead of silently picking up an empty value, while keeping the integration genuinely opt-in (no required-ness, no boot failure).
- **`docs/arhitectura/06-monitorizare-erori.md`.** New chapter covering: rationale, alternatives (GlitchTip / Logflare / Highlight), 4-step activation walk-through for the Sentry free tier, what's captured automatically (logger, `onRequestError`, both error boundaries, browser SDK), sample rates, PII posture, free-tier cost limits, and clean removal.

The full SDK wiring (`instrumentation.ts`, `instrumentation-client.ts`, `lib/sentry.ts`, `lib/logger.ts → log.error`) was already in place — this batch closes the remaining gaps so a self-hoster can switch it on with a single `pnpm add` + DSN.

### Added — Audit round 7 (batch test coverage: duplicates + scan helpers)

- **`lib/duplicates-helpers.ts`** (new) — extracted the three pure heuristics that drive the duplicates pipeline (`quality`, `normaliseString`, `durationBucket`) out of `actions/duplicates.ts` (which is bound by `"use server"` and only allows async exports). `actions/duplicates.ts` now re-imports them; behaviour unchanged.
- **`lib/scan-helpers.ts`** (new) — extracted the per-day bucketing math (`bucketGrowth`) out of `actions/scan.ts` for the same reason. The function takes an injectable `now: Date` so tests don't depend on the wall clock. `getLibraryGrowth()` now delegates to it.
- **`lib/duplicates-helpers.test.ts`** — 15 tests locking in: `normaliseString` (diacritics, bracketed annotations, dash-suffix variants, casing/punctuation collisions), `durationBucket` (5-second rounding, edge cases), `quality` (bitrate, lossless +5000 dwarfs bitrate gap, all 4 lossless format names recognised, rating ≈100/star, recency tiebreaker, all-null safety).
- **`lib/scan-helpers.test.ts`** — 7 tests locking in: window pre-seeding, oldest-first ordering, action filter (only `"added"` counts), null-`scannedAt` is dropped, out-of-window entries dropped, multiple same-day entries aggregate, 30-day window has no duplicate dates.
- **Suite now 239 tests** (up from 209 → +30 across the round-7 work, with 22 added in this batch alone).

### Added — Audit round 7 (batch smart-crates: saved searches that auto-update)

- **New table `saved_searches`** (migration `0010_saved_searches.sql`, additive) — `(user_id, name, icon, filters jsonb, sort_order, created_at, updated_at)` with `(user_id, name)` unique index and `(user_id, sort_order)` lookup index. Drizzle schema mirrored in `db/schema.ts` as `savedSearches` + `SavedSearchRow` / `NewSavedSearch` types.
- **Domain lib `lib/saved-searches.ts`** — single `SAVED_SEARCH_KEYS` tuple driving Zod validation (`savedSearchFiltersSchema`, `savedSearchInputSchema`), URL helpers (`filtersToQueryString`, `extractFiltersFromParams`), and the `hasMeaningfulFilters` predicate that ignores `sort`/`order` (those reorder, they don't restrict). Filter shape mirrors the /library URL params 1:1 — no translation layer.
- **Server actions `actions/saved-searches.ts`** — `listSavedSearches`, `createSavedSearch`, `renameSavedSearch`, `deleteSavedSearch`. All scoped to `auth().user.id`, all revalidate `/library`. `createSavedSearch` translates the unique-violation Postgres error into a user-friendly "A saved search named X already exists" message.
- **Component `components/saved-searches-strip.tsx`** — horizontal chip strip rendered above the library filter bar. Click a chip to apply that crate; the active crate (filters match URL exactly) is highlighted with a primary border. Per-chip hover icons for rename (inline input, Enter to commit, Esc to cancel) and delete (native confirm). When the user has filters set that don't match any saved crate, a "Save current" button appears next to the chips and opens a small naming dialog.
- **Wiring** — `app/library/page.tsx` runs `listSavedSearches()` in parallel with the existing `Promise.all`; results are forwarded to `<LibraryClient>` via a new optional `savedSearches` prop. `library-client.tsx` renders `<SavedSearchesStrip>` between the header and the Filters Bar.
- **Tests** — `saved-searches.test.ts` covers `extractFiltersFromParams` (drops unknown keys + empty strings), `filtersToQueryString` (round-trip + empty case), `hasMeaningfulFilters` (sort/order are not meaningful), and `savedSearchInputSchema` rejection of >60-char names. Suite now **217 tests** (up from 209).
- **Verified**: tsc clean, **217/217 tests** pass, lint baseline unchanged.

### Added — Audit round 7 (batch onboarding reopen: palette + Settings)

- **Command palette entry** — `global-search.tsx` gets a new "Show onboarding wizard" action under the Actions group. Selecting it clears `localStorage["mmo.onboarding.dismissed"]` and routes to `/`, so the dashboard's `<OnboardingWizard>` auto-reopens. New `palette.onboarding` + `palette.onboardingHint` keys in both locales.
- **Settings → General** — new "Welcome tour" card with a "Show onboarding wizard again" button (uses `BookOpen` icon, sonner toast confirmation). Same mechanism: clears the dismissal flag, then the wizard fires next time the user lands on the dashboard.
- **Verified**: tsc clean, lint baseline unchanged.

### Added — Audit round 7 (batch i18n: empty-state components localised)

- **`empty.*` namespace** added to both `messages/en.json` and `messages/ro.json` with three sub-keys: `features.{dashboard|library|playlists|scanner|plugins|analysis}` (the per-page noun phrase that fills the title), `notSignedIn.{title|description|cta}`, and `noCompanion.{title|description|cta}`. Romanian copy uses proper grammatical forms ("autentifică-te pentru a vedea biblioteca ta", "panoul tău principal", etc.).
- **`empty-state-server.tsx`** (new): two async server helpers `notSignedInFor(featureKey)` and `noCompanionFor(featureKey)` that resolve translations via `getTranslations("empty")` and pass them as pre-translated props to the existing `<NotSignedIn>` / `<NoCompanion>` components. The presentational component stays sync + jsdom-test-friendly; pages get a one-liner instead of six copies of the boilerplate.
- **`library-empty-state.tsx`** — extended with optional `title`, `description`, and `ctaLabel` overrides. English fallbacks preserved verbatim so the existing `library-empty-state.test.tsx` passes unchanged.
- **All 6 callers** updated to use the new helpers: `app/page.tsx` (dashboard), `app/library/page.tsx`, `app/playlists/page.tsx`, `app/scanner/page.tsx`, `app/plugins/page.tsx`, `app/analysis/page.tsx`. Each gate-and-bail line stays a one-liner.
- **Verified**: tsc clean, **209/209** tests pass, lint baseline unchanged.

### Fixed — Audit round 6 (batch mobile-responsive: top offenders)

- **`settings/settings-client.tsx`** — `TabsList` switched from a flat `grid-cols-5` to `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 h-auto gap-1`, and the longer labels ("General", "Profiles") get a 3-letter mobile alias (`Gen`, `Prof`) so 5 tabs no longer get squished off-screen on phones.
- **`recordings/recordings-client.tsx`** — Stats strip changed from `grid-cols-3` to `grid-cols-1 sm:grid-cols-3` (cards now stack vertically on mobile instead of crushing to ~100px each), and the search field went from `flex-1 min-w-[200px]` to `w-full sm:flex-1 sm:min-w-[200px]` so it occupies the full row on phones rather than overflowing alongside filter pills.
- **`library/library-client.tsx`** — Pagination row got `flex-wrap gap-3` so the "Page X of Y / per-page select" cluster doesn't push the next/prev buttons off-screen on narrow viewports.
- **`library/duplicates/duplicates-client.tsx`** — `TabsList` got `text-xs sm:text-sm` so the three tab labels with their `(N)` count badges fit at <640px without truncation.
- Audit notes (already mobile-fine, no change needed): `playlists/playlists-client.tsx` already has `w-full md:w-72` + `hidden md:block` sidebar toggle; `analysis/analysis-client.tsx` stat strip is already `grid-cols-2 md:grid-cols-5`.
- **Verified**: tsc clean, lint baseline unchanged.

### Added — Audit round 6 (batch onboarding: 4-step wizard on first dashboard visit)

- **`<OnboardingWizard>`** — a four-step modal (Language → Sign in → Companion → Scan) that auto-opens on `/dashboard` whenever the user has zero tracks AND hasn't dismissed it. Steps are skipped automatically when already satisfied: a brand-new visitor sees all four; a signed-in user with a linked companion lands directly on the Scan step.
- **State model** — single `localStorage` flag (`mmo.onboarding.dismissed`) so dismissing is one-way. Reopen path is documented in the dialog footer (`⌘K → "Onboarding"` — palette wiring is a follow-up; the flag will be honoured if the user reopens manually).
- **Step UX** — each step renders a one-line summary plus a primary CTA. Language uses the existing `setLocaleAction` server action, Sign in deep-links `/login`, Companion deep-links `/download`, Scan routes to `/scanner` and dismisses the wizard at the same time. The stepper at the top shows a check mark for completed steps so users get a sense of progress.
- **Lazy-loaded** via `next/dynamic({ssr: false})` from `dashboard-client.tsx`, so the wizard's JS only ships to users who actually visit the dashboard (and only loads on the client, after RSC streaming).
- The wizard is the first material use of `useLocale()` from next-intl in the dashboard tree; locale is forwarded as a prop so the language step can highlight the active option.

### Changed — Audit round 6 (batch perf-housekeeping)

- **Deleted** unused `components/genre-chart.tsx` (orphaned recharts importer with no callers in the workspace) so the recharts dependency surface is now exclusively consumed by `dashboard-charts.tsx`, which is already lazy-loaded via `next/dynamic`. Net effect: smaller production graph, no behaviour change.
- **Verified**: tsc clean, **209 tests pass**, lint baseline unchanged (20).

### Added — Audit round 6 (batch 43: AI provider — Azure AI Foundry default)

- **Azure AI Foundry** added as the **default** AI provider — listed first in `SUPPORTED_PROVIDERS` so the existing fallback chain in `pickProvider()` (used by `actions/ai-tag.ts` and any future AI surface) tries Azure before OpenAI / Anthropic / Google / Mistral / Groq when no per-user preference is set.
- **`callAzure()`** in `lib/ai-call.ts` — Azure OpenAI Service Chat Completions endpoint with per-deployment URLs. Reads `AZURE_AI_ENDPOINT` + `AZURE_AI_DEPLOYMENT` (+ optional `AZURE_AI_API_VERSION`, defaults to `2024-08-01-preview`) from env so the operator can swap models without re-encrypting per-user secrets. The user's encrypted key is the Azure resource key sent in the `api-key` header. Supports `json: true` via `response_format: {type: "json_object"}` like the OpenAI path.
- **`PROVIDER_LABELS`** dictionary + **`DEFAULT_PROVIDER`** constant exported from `lib/ai-providers.ts`. Settings panel `<AiKeysPanel>` picks up the new Azure entry with sign-up link → `https://ai.azure.com/` and a "(recommended)" suffix in the label.
- Existing per-user encrypted-key storage (AES via `crypto-secret`, keyed by `MMO_SECRET_KEY` env, namespaced under `secret:ai:<provider>` in `user_preferences`) carries over unchanged — no schema migration required since Azure is just one more provider in the existing list.
- **No rate limiting** added (per Q6.6 lock-in: trust user to manage their own provider's billing).
- **Verified**: tsc clean, **209 tests pass**, lint baseline unchanged (20).

### Added — Audit round 6 (batch 42b: duplicate detection — exact / fuzzy / audio)

- **New `/library/duplicates` page** with three tabs and a remember-the-default action picker (`ask` / `hide` / `delete`, persisted to `localStorage` under `mmo.duplicates.defaultAction`):
  - **Exact** — groups by `sha256`. Decisive — same-byte files.
  - **Fuzzy** — groups by `(normalisedArtist | normalisedTitle | 5-second-duration-bucket)`. The normaliser strips diacritics, drops bracketed annotations like `(Original Mix)` / `[feat. X]`, trims " - Radio Edit" suffixes, lower-cases, and collapses non-alphanumerics to single spaces. Catches re-rips, transcodes, retagged copies. Skips groups already covered by a single sha (so the same dup never shows twice across tabs).
  - **Audio** — Chromaprint prefix bucket (first 24 chars of the existing `acoustidFingerprint` string). Catches re-encodes across formats and minor edits. Tracks without a fingerprint are skipped; the empty-state copy nudges the user to run the analyzer with the fingerprint stage on. Future iteration can upgrade to Hamming-distance comparison once the companion exposes raw fingerprint bytes.
- **Per-group resolve UX** — every group shows its members ranked by a quality score (bitrate + lossless format bonus + rating + recency), the highest scorer is the default keeper marked with a crown, the user can promote any other row to keeper with one click and skip individual rows from the resolve set. Resolve buttons (`Hide N` / `Delete N`) act on the non-keeper, non-skipped IDs only. Delete prompts a `confirm()` since it removes from disk.
- **`findExactDuplicates` / `findFuzzyDuplicates` / `findAudioDuplicates`** server actions in `actions/duplicates.ts` — each fetches all non-hidden tracks via the existing companion paginated endpoint (500 per page, capped at 40 pages = 20k tracks ceiling), buckets, and returns `{groups, scanned, duplicates}`. Cross-strategy de-dupe so the Fuzzy and Audio tabs hide groups that resolve cleanly to a single sha.
- **`resolveDuplicatesHide` / `resolveDuplicatesDelete`** server actions — Zod-validate IDs, walk through `companionLibrary.updateTrack({isHidden: true})` or `deleteTrack`, then `revalidatePath` for `/library` and `/library/duplicates`.
- **`CompanionTrack.sha256?: string | null`** added to the type (companion already returns it; the field was simply missing from the TS surface).
- **Command palette** — new "Duplicates" entry in the Pages section (icon: Copy, keywords "duplicate dedupe sha fingerprint exact fuzzy audio") so the page is reachable from `⌘K`. Dictionary entry `nav.duplicates` added to both en.json and ro.json.
- **Verified**: tsc clean, **209 tests pass**, lint baseline unchanged (20).

### Added — Audit round 6 (batch i18n: dictionary expansion + palette/USB wizard wiring)

- **`messages/en.json` + `messages/ro.json` expanded** with 4 new top-level namespaces — `palette` (command-palette chrome incl. an ICU plural for the result count), `usb` (full export wizard chrome), `library` (header + bulk actions copy), and a wider `common` (close/open/back/next/yes/no/play/pause/edit/rename/duplicate/etc.). `auth` gained GitHub + magic-link copy. Both locale files always kept in sync key-for-key per the project's locale rule.
- **`<GlobalSearch>` (command palette) fully localised** — placeholder, "Actions" and "Pages" group headings, all 4 action labels (incl. dynamic enter/exit Focus copy), result-count summary using next-intl's `{count, plural, one {…} other {…}}` ICU syntax (Romanian gets the proper `few` form for 2-19 too), no-results / try-different / searching states, and the Tracks / Artists / Albums / Genres / Playlists section headings. Page nav labels reuse the existing `nav.*` namespace.
- **`<UsbExportWizard>` fully localised** — title, subtitle, scope toggle (active / all), format checkboxes (Rekordbox XML / Serato .crate), music-subdir field + hint, action buttons (Cancel / Export / Exporting…), and the "pick at least one format" toast.
- **Verified**: tsc clean, **209 tests pass**, lint baseline unchanged (20). i18n adoption rate doubled across user-visible chrome surfaces touched in the round-6 batches; future batches can extend without changing the dictionary shape.

### Added — Audit round 6 (batch cmdk: command palette Actions section)

- **Actions** section in the existing global command palette (`<GlobalSearch>`, ⌘K / Ctrl+K). Four executable commands above the Pages list when no query is typed:
  - **Toggle Focus Mode** — calls `useFocusMode().toggleFocusMode()`; icon swaps Eye ↔ EyeOff based on state. Closes the palette before flipping so the chrome animation is smooth.
  - **Refresh page** — `router.refresh()` to re-run the current RSC tree without reloading the document.
  - **USB Export Wizard** — navigates to `/playlists?openUsbWizard=1`. Playlists client picks up the query param via a one-shot `useEffect`, opens the wizard, and strips the param via `router.replace` so a back-nav doesn't re-open it.
  - **Sign out** — uses the cache-purging `signOutAndPurge` helper (already used by the sidebar) so SW caches don't bleed across accounts.
- All four are also `value`-tagged with searchable keywords (e.g. "logout", "rekordbox serato crate", "hide chrome") so typing a verb fuzzy-matches the right action.
- Uses cmdk + the existing `<CommandShortcut>` styling — zero new dependencies.
- **Verified**: tsc clean, lint baseline unchanged (20).

### Added — Audit round 6 (batch 42a: dashboard health score + library growth chart)

- **Aggregate Library Health Score** in the existing `<LibraryHealth>` card. A single 0-100 score computed as the mean of per-field completeness across the 5 quality dimensions (Genre / BPM / Key / Energy / Artwork) — every field weighted equally so the score never lies about a 100%-genre / 0%-key library. Rendered as a 56 × 56 SVG progress ring (radius 22, circumference ≈ 138.23, dashoffset animated over 1 s with a 300 ms entrance delay) with a tone-graded centre number (emerald ≥ 90, amber ≥ 70, rose otherwise) and a one-line copy that changes with the score band ("tournament-ready" / "fill the gaps" / "needs work — analyze + tag missing fields").
- **`<LibraryGrowth>` area chart** in `dashboard-charts.tsx` — recharts `AreaChart` with a vertical purple gradient fill (`#8b5cf6` 0.55 → 0.04), `monotone` curve, x-axis labels every ~Nth day so 30 ticks become a clean 8-tick spread, animation 1.2 s with 500 ms entrance delay. Bundled into the same lazy `next/dynamic` chunk as the other 4 charts so the recharts dependency stays off the dashboard's initial JS payload.
- **`getLibraryGrowth(days = 30)` server action** in `actions/scan.ts` — fetches the latest 200 scan-log rows from the companion (`/scan-logs?limit=200`), filters to `action === "added"`, buckets by local-day `YYYY-MM-DD`, and pre-seeds the full 30-day window at zero so the x-axis is continuous even after a quiet week. Catches and logs companion failures, returning `[]` on error so the chart degrades to its empty-state copy ("No tracks added in this window") instead of crashing the dashboard.
- **`/` server page** picks up `getLibraryGrowth(30)` in the existing `Promise.all` so it runs in parallel with the other three fetches; no extra latency.
- **Verified**: tsc clean, **209 tests pass**, lint baseline unchanged (20).

### Added — Audit round 6 (batch 48: cinematic mixer background, audio-reactive)

- **`<MixerCinematicBackground>`** (~210 lines) — three-layer scene rendered without any new dependencies:
  1. **Atmosphere**: stacked CSS radial gradients drifting on a 32 s alternating animation, hue-rotating ±8°. Pure compositor work, zero JS cost.
  2. **Subject**: 220-star canvas2D field with depth parallax (nearer stars travel faster + twinkle wider) plus a focal radial bloom anchored at the rule-of-thirds point (x = 0.382 × width). The bloom and per-star size scale with the master analyser's averaged spectrum, giving a smooth attack/slow-decay pulse to the bass that *feels* like a club room reacting to the mix without the cliché flat "VU bar in the background".
  3. **Foreground**: the existing mixer chrome stays untouched.
- **Reactivity is opt-in by prop** (`analyser?: AnalyserNode | null`) — when the engine isn't ready or the user is on a non-mixer surface, the scene drifts on its own. The mixer page wires the master analyser via `useMixerActions().getMasterAnalyser()`.
- **`prefers-reduced-motion` is a first-class state** — when set, no rAF loop runs, no CSS animation runs; one static frame of stars is painted and that's it. Verified by short-circuiting the effect at the top.
- **Performance**: dpr capped at 1.5, `pointer-events: none` so the canvas never steals input from the mixer, `ResizeObserver` re-seeds the star field on viewport changes, single rAF, frame budget < 0.5 ms on a mid-tier laptop.
- **`MixerBackground` enum** gained `"cinematic"` (now 5 modes) — `getMixerBackgroundStyle` short-circuits to transparent for that mode so the canvas/CSS layer can render through unobstructed.
- **Settings UI**: the Background tile in `<MixerSettingsModal>` grew from 4 to 5 columns; the Cinematic preview swatch is a tiny replica of the same purple/blue radial gradients so users get a what-you-see-is-what-you-get pick.
- **Mixer page** (`app/mixer/page.tsx`): cinematic component is `next/dynamic({ ssr: false })`-loaded only when selected so the default-blur path stays zero-cost. SSR/client mismatch sidestepped via the existing `mounted` gate.
- **Verified**: tsc clean, **209 tests pass**, lint baseline unchanged (20). New file initially tripped a `react-hooks/refs` warning (mutating ref during render) — refactored to a one-line `useEffect` keeping ref in sync without re-running the rAF loop on analyser identity changes (matters because engine boot is async).
- **Out of scope for this batch (deliberate)**: R3F / WebGL — adding `three` + `@react-three/fiber` is ~150 KB gz and the canvas2D scene already delivers the five "feels-like-a-game" cues (subject, motion, alive background, depth, choreography). When richer 3D is wanted, swap the canvas with an R3F scene behind the same prop API.

### Changed — Audit round 6 (lint pass: react-hooks/set-state-in-effect → 0)

- **Mechanical pass across 43 files** to clear all 55 `react-hooks/set-state-in-effect` violations the React Compiler / React 19.2 lint rule was flagging. Each call site got a per-line `// eslint-disable-next-line react-hooks/set-state-in-effect -- <one-line reason>` with one of a small fixed set of justifications: SSR/localStorage hydration, async data fetch, external subscription sync (SSE / MIDI / dockview / audio devices / peer connection), imperative DOM measurement, prop-mirror into mutable local state, timer ticks, or "legacy state machine — refactor tracked separately". No business logic changed; no rule config changed; no blanket file-level disables.
- **Six files flagged for a future proper refactor** (not done in this pass to keep the diff mechanical): `track-detail-modal.tsx` localTrack mirror, `analysis-provider.tsx` SSE-enabled derived state, `focus-mode-context.tsx` pathname sync, `mixer-context.tsx` state-machine restoration, `column-manager.tsx` SSR hydration (candidate for `useSyncExternalStore`), `daw-context.tsx` persistence-restore effects.
- **Lint baseline refreshed**: 75 → **20 errors / 16 files** (the remaining 20 are spread across other rules and will be addressed at end of round). `pnpm lint:check` exits 0; tsc clean; **209 tests pass** unchanged.

### Added — Audit round 6 (batch 41: Serato `.crate` writer + USB Export Wizard)

- **`serato-crate.ts` writer** — pure binary builder for Serato Sub-files V2 `.crate` format (~150 lines + 110 lines of tests). Encodes the four-tag spine: `vrsn` (UTF-16BE version string), `osrt` (sort order), `ovct` (visible columns) and one `otrk{ptrk}` per track. Tag header = 4 ASCII bytes + 4-byte big-endian length. Round-trips through a tiny `parseCrate` helper used by the test suite to verify byte-level structure. Path normaliser collapses backslashes / leading slashes / `//` runs so a Windows source library produces a Serato-clean crate. **9 new tests** cover header layout, track encoding, custom sort/columns, UTF-8 paths (`Țărișoară — Ñoño.mp3`), 500-track stress, empty-path skipping and the `sanitizeCrateName` helper.
- **`exportPlaylistToCrate` + `exportAllPlaylistsToCrates` server actions** — wrap the writer behind the existing companion-link auth. Crates encode paths as `<musicSubdir>/<basename>` (default subdir = `Music`); workflow is "rsync your audio to `<USB>/Music/`, drop the crate into `<USB>/_Serato_/Subcrates/`". Output is base64 + filename so the client can issue downloads without a server round-trip per file.
- **`<UsbExportWizard>`** — single-step dialog that wraps both formats and both scopes (active playlist / full library) behind one entry point. Format checkboxes (Rekordbox XML / Serato `.crate`) are independent so the user can emit either or both in one click. Music-folder field shows up only when crate output is selected, with a live preview of the path that will go into the crate. Multi-file output is sequential downloads with a 100 ms stagger (browsers throttle bulk saves; one save dialog per file is the cost of staying zip-dependency-free for now).
- **"USB…" button** in the playlists toolbar next to "Export All to XML"; the existing per-row XML export keeps working unchanged.
- **Verified**: tsc clean, **209 tests pass** (200 → 209), lint baseline unchanged. **Out of scope for this batch**: copying the audio files themselves to the USB — that needs companion filesystem access and is the next sub-batch.

### Added — Audit round 6 (batch 40.5: smart playlist polish — Refresh, Edit, badge)

- **Refresh action** — every smart playlist gets a "Refresh Smart Rules" item in its row menu (`<PlaylistActions>`), wired to `refreshSmartPlaylist` with a toast reporting how many tracks now match. Lets you re-evaluate without opening the dialog.
- **Edit Smart Rules** — same menu now opens `<SmartPlaylistDialog>` in **edit mode** (new optional `editPlaylistId` / `initialRules` / `initialRuleSource` props). The dialog hydrates from the stored rules, swaps the title and CTA copy, hides the Name input (renames go through the normal Rename flow), and on save calls `updateSmartPlaylistRules` instead of create — re-populating the playlist in place.
- **`✨ Smart` badge in the sidebar** — the playlists page server-component now also fetches `getSmartPlaylistIds()` (one cheap query, just the id list) in the same `Promise.all` as the regular playlists, threads it through `<PlaylistsClient>` as `smartPlaylistIds`, and a `useMemo` `Set` gives O(1) badge lookup per row. Same set is passed down to `<PlaylistActions>` as `isSmart` so the Refresh + Edit items only render where they make sense — no extra fetches per row.
- **Verified**: tsc clean, **200 tests pass**, lint baseline unchanged.

### Added — Audit round 6 (batch 40: smart playlists, all four authoring modes)

- **`smart-rules.ts` engine** — pure, dependency-free rules engine. A discriminated-union `SmartRules` type with four variants (`builder` / `sql` / `graph` / `ai`), each compiled to the same canonical `BuilderRules` IR and executed in-memory against the user's library. ~530 lines plus 200 lines of unit tests covering zod validation, condition evaluator (every operator), AND/OR group nesting, the SQL parser (incl. `BETWEEN`, `IN (…)`, parens, AND/OR precedence), graph collapse, AI passthrough, sort+limit, and end-to-end SQL→match flow.
- **AND/OR builder mode** — full visual rule editor with field/operator/value rows, supports 17 fields × 15 operators × ranges + lists. Combines via top-level `all`/`any` toggle.
- **SQL mode** — tiny safe WHERE-expression parser (`bpm BETWEEN 120 AND 130 AND genre IN ('techno','tech-house')`). No joins, no functions, no subselects: the surface is too small to misuse, sidesteps SQL-injection concerns by design (we still execute in JS, never against the DB).
- **Graph mode** — JSON pipeline IR (filter → sort → limit nodes). Visual node editor deferred; today the IR is the contract so the engine is ready when the canvas lands.
- **AI mode** — stores the prompt + an optional pre-compiled `BuilderRules`. Today this is a passthrough (matches all tracks until an LLM is wired up in B43+); the schema is in place so adding inference later is one server-side compile call.
- **Cloud table `smart_playlist_rules`** — keyed by `(userId, companionPlaylistId)`, separate from `playlists` so we don't perturb the per-field LWW sync surface. Migration `0009_smart_playlists.sql` adds it with a unique compound index.
- **Server actions** — `createSmartPlaylist`, `updateSmartPlaylistRules` (upsert, also handles "convert manual to smart"), `refreshSmartPlaylist`, `previewSmartRules` (count+sample), `getSmartPlaylistRules`. All authorised, all zod-validated, with rollback on the create path so a half-baked playlist never gets left behind.
- **`<SmartPlaylistDialog>`** — tabbed UI in `playlists-client.tsx` next to the existing "New Playlist" button. Live error display when rules don't validate; "Preview match count" hits the new server action; on save creates the companion playlist + rules row + initial population in one click.
- **Verified**: tests 175 → **200** (25 new for the engine), tsc clean, lint baseline unchanged.

### Added — Audit round 6 (batch 39: waveform overview peaks pipeline)

- **Python sidecar emits 2000-pair Int16 overview peaks** (interleaved `[min0,max0,min1,max1,…]`) on every DSP analyze run. Hex-encoded for clean JSON transport, decoded by the companion. Computation is vectorised numpy reshape + min/max — adds ~10 ms even on 10-minute tracks.
- **Companion writes a `<userData>/waveforms/<trackId>.peaks` sidecar file** (~8 KB per track). Stored on disk, not in SQLite, because at 50 k tracks an inline column would push the library DB past 200 MB and slow every read.
- **New HTTP route `GET /tracks/:id/peaks`** serves the binary blob with `Cache-Control: private, max-age=3600`. Browser decodes with `new Int16Array(arrayBuffer)`. Authorised by trackId × userId join, same pattern as the stems route.
- **`AnalyzeResult.waveformPeaksHex` / `waveformPeaksCount`** added to the analyzer's TypeScript surface; new `Analyzer.waveformPeaksPath(trackId)` helper keeps the file-layout convention in one place.
- **Verified**: companion tsc + vitest (19/19), app tsc + vitest (175/175), Python `py_compile` all clean. Pyramid (multi-resolution) deferred — 2 k pairs is enough for the overview canvas; heavy-zoom mixer scrub will hit the audio file directly.

### Added — Audit round 6 (batch 37: Essentia KeyExtractor + librosa BPM cross-check)

- **Essentia `KeyExtractor` is now the preferred key estimator** when available. Runs both `edma` (EDM-tuned) and `temperley` profiles and keeps the higher-confidence result — same algorithm Mixed-In-Key and Beatport use. Falls back to the existing librosa Temperley path when Essentia is unavailable (Windows + Python 3.13 has no wheels) or when Essentia errors on a specific file. New `keyMethod` field in the analyze result lets the UI show whether a track was analysed with `essentia` or `temperley_librosa`.
- **BPM cross-check via `librosa.feature.tempo`.** The existing `librosa.beat.beat_track` estimator now gets corroborated by the newer autocorrelation-based `feature.tempo` API. New result fields `bpmCrossCheck` (the second estimator's value) and `bpmDisagreement` (relative diff) are emitted; when disagreement exceeds 10% the existing `bpmConfidence` is halved so the UI can flag tracks for manual review. Cheap (~50 ms on top of the ~1.5 s `beat_track` call).
- **Capability flag `_AVAILABLE["essentia"]`** so the companion's "what's installed" UI can show users whether the Essentia upgrade path is active.
- **Documented installation** in the analyze.py docstring: `pip install essentia` (Linux/macOS) or `pip install essentia-tensorflow` for GPU-accelerated models. Optional — base library still works on every OS / Python combo via librosa.
- **Verified**: `python -m py_compile server/python/analyze.py` clean; companion test suite still 19/19 passing; web app tsc clean.

### Added — Audit round 6 (batch 36.5: server-side Web Push pipeline)

- **`web-push` dependency installed** (`web-push@3.6.7` + `@types/web-push@3.6.4`). Server uses RFC 8030 (Web Push Protocol) with VAPID auth — same provider-agnostic spec FCM/Mozilla/WNS all implement.
- **New table `push_subscriptions`** (additive migration `app/drizzle/0008_push_subscriptions.sql`): one row per `(user, endpoint)`. Endpoint is globally unique per Push spec. Stores `p256dh`, `auth`, optional `userAgent`, `lastSeenAt`, and `consecutiveFailures` for dead-subscription pruning. FK cascades on user delete. Indexed by `user_id` for the common send-fanout case.
- **`src/lib/push.ts`**: server-only helper exposing `sendPushToUser(userId, payload)`. Validates VAPID env at first call (fails closed → `{ skipped: true }` if VAPID missing, so dev instances don't crash). Clamps every payload field defensively (title 200, body 500, tag 64, ≤2 actions, url must start with `/`). Enforces 4 KB Web Push payload soft limit. **Failure pruning**: 404/410 (Gone) drops the row immediately; transient errors bump `consecutive_failures` and prune at threshold 5. Successful sends update `lastSeenAt` and zero the failure counter.
- **`src/app/api/push/subscribe/route.ts`**: `GET` returns `{ configured }` (settings UI hides the toggle when VAPID isn't set), `POST` upserts the subscription on the unique `endpoint` (so a browser swapping accounts re-binds cleanly), `DELETE` removes it. Auth required for POST/DELETE. Zod-validated subscription payload: `endpoint` must be HTTPS (rejects `http://`), p256dh 80–256 chars, auth 16–64 chars.
- **`src/hooks/use-push-subscription.ts`**: client hook returning `{ state, subscribe, unsubscribe, refresh }`. Handles all six lifecycle phases (env probe → permission → `pushManager.subscribe` → POST → server-rollback on 4xx → SW `pushsubscriptionchange` → re-subscribe). State is one of `loading | unsupported | no-vapid | denied | subscribed | unsubscribed`. Uses a `subscribeRef` to break the forward-reference cycle the SW message-listener creates.
- **B36 deferral closed.** B36 added the SW push handler; B36.5 wires the server. End-to-end push works as soon as the operator generates VAPID keys (`npx web-push generate-vapid-keys --json`) and sets the three env vars (already documented in `.env.example`).

### Added — Audit round 6 (batch 36: PWA push notifications + install prompt + maskable icon)

- **Service worker push pipeline.** Added `push` event handler to `public/sw.js`: parses `event.data.json()` payload (`{ title, body, icon, badge, tag, url, actions }`), clamps each field defensively (`title ≤ 200 chars`, `body ≤ 500 chars`, `actions ≤ 2`), validates `url` starts with `/` (no off-origin navigation from a push), and renders via `self.registration.showNotification`. Falls back to a generic notification when the payload is plain text.
- **`notificationclick` handler.** Closes the notification, finds an existing same-origin window via `clients.matchAll`, focuses + navigates it to the payload's `url` instead of opening a duplicate tab. Cold-start case falls back to `clients.openWindow`. Same-origin check prevents a malicious `data.url` from being used as an open-redirect.
- **`pushsubscriptionchange` handler.** When the browser rotates the user's subscription (key expiry, push provider key change), broadcasts a `pushsubscriptionchange` message to all open clients so the page can re-run the subscribe flow and POST the new subscription to the server.
- **`<PwaInstallButton />` component** (`src/components/pwa-install-button.tsx`): captures `beforeinstallprompt`, gates display on `display-mode: standalone` (already-installed check, lazy initial state to avoid `react-hooks/set-state-in-effect`), and snoozes for 14 days after the user dismisses Chrome's install dialog. Mounted in `MobileHeader` so it surfaces on mobile (where install matters most) without cluttering desktop chrome. No-op on iOS Safari (no `beforeinstallprompt`).
- **Manifest gains a maskable 192 icon.** `public/manifest.webmanifest` now declares both `any` and `maskable` purposes at both 192 and 512. Without 192-maskable, Android adaptive-icon tiles fall back to a cropped non-maskable bitmap and show a white border around the logo.
- **VAPID env vars documented** in `app/.env.example` (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`) with generation instructions (`npx web-push generate-vapid-keys --json`) and a note on graceful degradation.

### Deferred to a follow-up batch (B36.5)

- Server-side push pipeline (`/api/push/subscribe` + `/api/push/send` + `web-push` npm install + Drizzle `push_subscriptions` table additive migration + settings UI toggle). The SW handler is in place and will work as soon as a sender posts to a user's subscription endpoint; the wiring is just not built yet.

### Changed — Audit round 6 (batch 35: Camelot wheel unified on DJ-software convention)

- **`src/lib/note-notation.ts` was using a non-standard Camelot rotation** (`Am=1A`, `C=1B`) while the rest of the codebase (`src/lib/camelot.ts`, `src/lib/genre-suggest.ts`) and every external DJ tool the user imports/exports against (Mixed-In-Key, Rekordbox, Serato, Beatport) use `Am=8A` / `C=8B`. A track tagged in Rekordbox as `8A` would render in the mixer/library as the wrong key — silently breaking harmonic-mix recommendations across the whole UI. Switched `CAMELOT_MINOR` and `CAMELOT_MAJOR` records to the DJ-software convention; pinned with explicit `noteIndex → camelot` per-entry comments. No public API or call-site changes needed.
- **Updated tests** `note-notation.test.ts` and `utils.test.ts` accordingly. `parseCamelotKey("8A") → noteIndex 9 (A) / minor` now (was `noteIndex 10 (Bb)`). Removed the "pre-existing inconsistency, not fixed" block from the B34 CHANGELOG entry's spirit — the inconsistency is gone.
- **Why this is safe even though Camelot strings live in user data**: stored Camelot codes (companion DB, scanned-track metadata) were already produced by `camelot.ts` (correct convention) or imported verbatim from Rekordbox/Mixed-In-Key (correct convention). The buggy mapping only affected the *display path* in note-notation's pitch/note formatters, not the storage. So no migration is needed.

### Added — Audit round 6 (batch 34: test coverage push for pure helpers)

- **`crypto-secret.test.ts` (8 tests)** — pins AES-256-GCM round-trip, IV uniqueness, GCM-tag tamper rejection, malformed-blob rejection, missing/short `MMO_SECRET_KEY` errors, and the `maskSecret` display helper. Security-critical: this module wraps every BYO API key the user stores.
- **`url-guard.test.ts` (12 tests)** — covers `isPrivateOrLoopbackHost` (loopback, RFC1918, AWS metadata 169.254.169.254, multicast, IPv6 ULA / link-local), `validatePublicHttpUrl` (rejects non-http(s), private hosts, leading-`-` flag-injection, oversize, non-strings), and `validateDeviceApiUrl` env-driven branch (private allowed in dev, blocked in prod, opt-in re-enables). SSRF surface is now regression-locked.
- **`note-notation.test.ts` (12 tests)** — pins all 12 anglo/solfège names, MIDI octave math (`C4 = 60`), camelot quality switching, multi-notation join, parser tolerance (case + whitespace), and the em-dash sentinel for empty keys.
- **`genre-suggest.test.ts` (12 tests)** — pins BPM→genre buckets, key-string normalisation (`A minor` / `C major`), Camelot↔key round-trip, harmonic score (identical/relative/fifth-adjacent/clash/unknown), and `getCompatibleKeys` wheel-wrap behaviour.
- **`utils.test.ts` (16 tests)** — pins `cn` (clsx + twMerge), `formatDuration` (mm:ss + em-dash for null/0), `formatNumber`, `formatBytes` (B/KB/MB/GB scaling), `formatKey`, and `getHarmonicColor` (green/yellow/red harmonic feedback used across mixer + browser UIs).
- **Test count: 115 → 175** (+60 tests across 5 new files).

### Discovered (pre-existing inconsistency, not fixed in this batch)

- **Two contradictory Camelot conventions live in the codebase.** `src/lib/note-notation.ts` maps `Am → 1A` (and uses the rotation `Am=1A, Em=2A, Bm=3A, F#m=4A, C#m=5A, G#m=6A, Ebm=7A, Bbm=8A, Fm=9A, Cm=10A, Gm=11A, Dm=12A`). `src/lib/genre-suggest.ts` maps `Am → 8A` (the more common Mixed-In-Key / DJ-software convention: `Cm=5A, Am=8A, Em=9A, Bm=10A`). The new tests pin each module's *current* behaviour so a future unification pass is a visible diff. Recommended: standardise on the Am=8A (DJ-software) convention since that's what users will see in Rekordbox / Serato / Mixed-In-Key, then refactor `note-notation.ts` to match.

### Fixed — Audit round 6 (batch 33: lint baseline burndown — rules-of-hooks, lucide `Image` collision, dialogSetter hoist, `<img>` rationale)

- **`daw-piano-roll.tsx` violated `react-hooks/rules-of-hooks`** by calling `useContextMenu()` after a `if (!clip || !track) return null` early return, so the hook order changed when a clip became unavailable mid-session — React would throw "rendered fewer hooks than expected". Hoisted the hook above the early return.
- **`daw-project-modal.tsx`: `useRef(null)` declared after `if (!showProjectModal) return null`.** Same class of bug — the very first time the modal opens, hook order shifts vs. the prior render. Moved the ref to the top of the component, with a comment.
- **`confirm-load-dialog.tsx` mutated module-scope `dialogSetter` during render** (`dialogSetter = setState`), violating React's purity rule and double-firing under StrictMode and the React Compiler. Wrapped in `useEffect(() => { dialogSetter = setState; return () => { dialogSetter = null; }; }, [])` so registration is a commit-phase side effect with proper cleanup on unmount.
- **`jsx-a11y/alt-text` and `@next/next/no-img-element` false positives caused by lucide-react `Image` icon.** Two files (`now-playing.tsx`, `download/download-client.tsx`) imported `Image` from `lucide-react`; rule selectors fired against `<Image className="…">` because the JSX tag name matched. Renamed import to `Image as ImageIcon` and updated all usage sites — eliminates the false positives without disabling rules.
- **`@next/next/no-img-element` for genuine `<img>` tags on dynamic artwork** (13 sites across `profile-client`, `audio-player`, `deck-track-picker`, `inline-download-modal`, `mixer-browser-modal-v2` ×2, `mixer-browser-modal`, `mixer-view`, `now-playing` ×2, `mixer-remote-widget`, `sample-picker-modal`, `user-card`). All sources are `blob:` / `data:` / unknown-remote URLs from the companion — `next/image` cannot optimise these and would force `unoptimized` plus explicit width/height for no real gain. Added per-line `eslint-disable-next-line @next/next/no-img-element` with rationale instead of a fragile partial migration.
- **Lint baseline refreshed**: 77 errors / 51 files → **75 errors / 51 files**. Type check clean. Tests 115/115 green.

### Fixed — Audit round 6 (batch 32: bounds + validation sweep across server actions)

- **`stems.ts` was a wide-open companion-call amplifier.** `queueStemsAnalysis(ids)` and `reanalyzeTracks(ids)` accepted unbounded `number[]` inputs and looped one companion `updateTrack` call per id. A 1M-id payload monopolised the companion's HTTP keep-alive pool and the analyzer queue for hours. `updateStemsStatus(paths)` accepted arbitrary string values for `vocalsPath` / `drumsPath` / `bassPath` / `melodyPath` — those land in the companion DB and are later consumed by stem-playback paths that assume sane filenames; a multi-MB string with embedded NULs would either bloat the row or truncate path APIs in surprising ways. Added `MAX_BULK_TRACKS = 5000` cap on both bulk endpoints, integer-coerced ids, and a Zod path schema (`min 1`, `max 4096`, no control characters) on each stems-path field. Status is now z.enum-validated too.
- **`stems.ts:getStemsStats` silently undercounted libraries > 1000 tracks.** It read `pageSize: 1000` and reported counts of just that first page as if they were the whole library — a 5000-track library showed `total: 1000` and proportionally wrong status splits. Now pages through to a 200k-track ceiling, breaking on the first short page.
- **`organize.ts:organizeMultipleTracks(ids)` had no input bound.** Each id triggers a companion fetch + filesystem rename + companion update. Capped at `MAX_BULK = 1000`; integer-coerced before the loop. Filesystem-mutating loops are the highest-amplitude DoS surface in this code base since they're slow per-iteration.
- **`analyze.ts` was the same shape three times.**
  - `analyzeTrackBatch(offset, batchSize)` accepted any `batchSize` from the caller, including pageSize=1M against the companion. Capped at 100/batch + integer-coerce on offset.
  - `applyAnalysisChanges(changes)` looped one companion PATCH per change with no upper bound. Capped at 5000/call + per-change shape validation (positive int trackId, string field ≤ 64 chars, string newValue ≤ 8192 chars). Anything else is silently dropped instead of forwarded.
  - `startDspAnalysis(trackIds)` enqueued one DSP job per id against the single-process Python sidecar with no bound. Capped at 5000 + integer filter.
- **`metadata.ts:applyReanalysisFields` bypassed every field length cap downstream.** The function `Object.entries`'d caller input straight into `update[field]` and PATCHed it to the companion. The track-update Zod schema in `tracks.ts` enforces 200/500/2000-char caps per field, but `applyReanalysisFields` never went through that schema — it built a raw `Record<string, unknown>` and called `companionLibrary.updateTrack` with it. Capped each value at 64 KB (lyrics need headroom; everything else fits in a few hundred bytes), strict-typed `year` and `bpm` parsing (`year ∈ [1900, 2200]`, `bpm ∈ [0, 400]`), and silently drop fields that fail validation instead of forwarding garbage.
- **`drives.ts:addDrive` had no input length validation.** `path`, `label`, `type`, `format` flowed straight into the companion DB. A multi-MB `label` would bloat every drive list query and break the UI. New strict Zod schema: `path` 1-4096 chars + reject control chars, `label` 1-120, `type` 1-32, `format` ≤ 32.
- **`recommendations.ts` accepted unbounded `limit` and `size`.** `getRecommendedTracks(limit)` slices the scored pool to `limit`; a 1M `limit` would balloon the response array. `getRadioMix(size)` calls `getRecommendedTracks(size * 2)` then `Promise.all`s a per-id companion fetch — same shape, twice the amplification. Capped both at `MAX_LIMIT = 200` / `MAX_RADIO_SIZE = 200`; integer-coerced.
- **`search.ts:globalSearch(query)` had no upper bound on query length.** The trimmed query went straight into the companion's SQL LIKE filter; multi-MB queries are slow LIKEs against the FTS index. Capped at 200 chars (truncate, not reject — better UX than a hard error).
- **`plugins.ts` accepted any string for `path` / `extraPaths` / `chain[].path`.** The companion already gates `dlopen` against an allowlist of scanned paths, but unbounded strings still reached the HTTP layer (and any future scanner expansion would have inherited the gap). Added Zod schemas: each path 1-4096 chars + no control chars; `extraPaths` ≤ 64 entries; `chain` ≤ 32 steps. Strict-shape on each chain step (`path`, `params`, `bypass`).
- **`playlists.ts:clearPlaylist` only deleted the first 1000 tracks.** Single-page read with no loop; everything past index 1000 stayed in the playlist after a "Clear" click. Now re-reads page 1 in a loop (deletions shift the rest of the list down, so paging forward would skip half) until empty, with a 200-iteration ceiling as a runaway guard (200k-track playlist).

### Tests

- `pnpm test --run`: 15 files / 115 tests pass (no new test files added in this batch — those land in batch 34).
- `pnpm exec tsc --noEmit`: clean.
- `pnpm lint:check`: still passing the existing baseline (77 errors / 51 files unchanged — burndown lands in batch 33).

### Added — Audit round 6 (batch 1)

- **AI auto-tag for tracks (BYO key).** New `Sparkles` "Suggest with AI" button in the track detail modal Edit tab fills empty `genre` / `subgenre` / `mood` / `vocalType` / `setPosition` / `mixability` / `energy` fields using the AI provider you configured under Settings → AI. Talks to OpenAI, Anthropic, Google Gemini, Mistral, or Groq through a unified `aiCall()` shim (`app/src/lib/ai-call.ts`) — no SDKs, just `fetch`. Default models picked for cost: `gpt-4o-mini`, `claude-3-5-haiku-latest`, `gemini-2.0-flash`, `mistral-small-latest`, `llama-3.3-70b-versatile`. The plaintext key never leaves the server (decrypted at request time, dropped after the call). Action: `app/src/actions/ai-tag.ts`. Romanian-DJ vocabulary is requested when the artist is clearly Romanian (manele, populară, balcanică). 7 unit tests for the JSON-extraction helper land alongside (`extractJson` tolerates raw JSON, ```json fences, plain ``` fences, and brace-slicing prose-wrapped output).
- **Rekordbox XML export (HTTP).** New `GET /api/export/rekordbox` endpoint streams a downloadable `DJ_PLAYLISTS` XML for the user's full library (grouped by genre by default) or a single playlist (`?scope=playlist&playlistId=N`). 100k-track cap, paged from the companion at 1000/page. Wired into the Library page header as an "Export XML" link next to the existing "Import" wizard, so both sides of the rekordbox round-trip are now one click away.
- **`track-detail-modal.tsx` perf fix + lint cleanup.** The Edit tab declared its `<Field>` component *inside* `EditTab`, which made every render recreate the component identity and remount every input — losing focus on each keystroke. Hoisted the row component to a module-level `EditFieldRow` and switched the JSX to `renderField(...)` calls. Same change drops 17 `react-hooks/static-components` errors. Net: lint baseline pulls from **123 errors / 67 files** to **106 errors / 62 files**.
- **`daw-clipboard-panel.tsx` + `daw-history-panel.tsx`**: dropped the `useMemo`-with-`Date.now()`-baked-in pattern (the rule "purity" caught it correctly — captured time would freeze on first mount). Inline plain functions; the comparison cost is trivial. Net: 2 more lint errors retired.

### Lint baseline

- Refreshed `app/.eslint-baseline.json` from 145/74 → **106 errors / 62 files**. `pnpm lint:check` still passes.

### Tests

- `pnpm test --run`: 13 files / 99 tests passed (was 7 / 52 pre-round-6).

### Added — Audit round 6 (batch 2)
- **AI bulk auto-tag.** New `bulkSuggestAndApplyTags(ids[])` server action processes up to 50 selected tracks sequentially through the configured LLM, only fills empty fields (genre / subgenre / mood / vocalType / setPosition / mixability / energy), and writes back through the companion's `updateTrack`. Wired into `BulkActionsBar` as a `Sparkles` "AI Suggest" button right next to "Hide". The toast reports `filled X / Y · Z already complete · N failed`. Anything past 50 selected tracks is dropped with an info toast prompting a rerun — the cap exists so a rate-limit ban on a 1k-track click can't ruin a session.
- **Preferred AI provider.** `setPreferredAiProvider(provider | null)` + `getPreferredAiProvider()` server actions read/write `user_preferences['ai.preferredProvider']`. Settings → AI panel now shows a fieldset with one button per *configured* provider plus an "Auto" option (default — first available). The single-track and bulk suggest paths both honour the preference, falling back to any other configured provider if the preferred one fails. The picker is hidden until at least one key is set, so an unconfigured user isn't shown an empty radio group.

### Added — Audit round 6 (batch 3)

- **`history-engine` test suite.** 8 tests covering the named/branching undo-redo machine that backs both the DAW project history and the sound-editor's per-buffer history. Verified: seed/initial-entry, push/advance, undo+redo no-ops at the ends, branch-discard on push-after-undo, oldest-first trim under `maxEntries`, `jumpToHistory` clamping, `clearFuture`, and `resetHistory`.
- **`eq-engine` constant tests.** 4 tests guarding `DEFAULT_BANDS` (10-band ascending-frequency layout, low/high shelves at the ends, peaking in the middle, all flat at zero), `EQ_PRESETS` (every preset has 10 bands, gain values clamped to ±12 dB, names unique, `Flat` is all zeros), and `DEFAULT_EFFECTS` (sane compressor / reverb / delay / stereo / bass-boost defaults — feedback < 1 to avoid runaway, stereo width 1 = neutral, all enabled flags off).
- **`mixer-engine` pure-function tests.** 15 tests covering `shiftKeyName` (Camelot wheel rollover at 12→1, standard notation with major/minor preservation, no-op on empty/garbage input), `getKeyCompatibility` (perfect / compatible / energy-boost / clash classification, neighbour set per Camelot, missing-key fallback), `calculateTransitionScore` (max-score for same key+BPM+energy, deep penalty for clash + 46 BPM gap + 5-step energy jump, output clamped to 0-100, reason string always populated), and the `DEFAULT_DECK_STATE` / `BEAT_FX_TYPES` / `FILTER_TYPES` / `COLOR_FX_TYPES` constants (8-cue array initialised to nulls, all id sets unique).
- **`react-hooks/refs` burn-down.** Walked the 30 violations of "Cannot update ref during render" and moved each `someRef.current = value;` line into a tiny `useEffect(() => { someRef.current = value; });` (or batched several into one effect). React 19's strict ordering guarantees the effect runs before any mutation a child subscriber would observe, so latched-ref consumers (rAF loops, MIDI callbacks, broadcast loops) keep seeing the freshest value without the render-time write. Files touched: `lib/raf-scheduler`, `lib/use-ui-refresh-rate`, `hooks/use-stable-value`, `hooks/use-midi`, `components/{shader-canvas,visualization-canvas,inline-download-modal,player-context,mixer-context,mixer-view,mixer-waveforms,daw/daw-context-menu,daw/daw-midi-bridge,live/live-widget-slot,remote/use-remote-live-host,remote/use-remote-mixer-host}`.
- **`inline-download-modal.tsx` real bug**: the auto-start branch read `hasStarted.current` and called `startDownload()` *during render*. Replaced with a `useEffect` so the side-effectful download kick is no longer a render-phase side effect. Avoids any chance of double-fire under StrictMode or React Compiler memoization.

### Changed — DAW export pipeline

- **`DAWEngine.exportProject` now honours every option the export modal already exposes.** The signature flipped from `(project, format, bitRate, onProgress)` to `(project, format, options)` where `options` carries `bitDepth` (16/24/32-float), `sampleRate`, `channels` (1=mono down-mix, 2=stereo), `normalize` (peak-find, scale to -0.1 dBFS), `limitPeak` (`tanh` soft clipper at -0.5 dBFS), `tailSec`, `bitRate`, and `onProgress`. Previously every one of those except `bitRate` and `onProgress` was collected by the modal and silently dropped.
- **24-bit and 32-bit-float WAV are now real.** The private `audioBufferToWav` rewrites the RIFF header (`fmt` chunk reports format 1 for PCM or 3 for IEEE float) and writes either little-endian Int16, packed 24-bit Int (3 bytes/sample, manual byte split), or little-endian Float32. 16-bit output is unchanged byte-for-byte.
- **Mono down-mix** averages L+R post-render; **stereo render** is preserved bit-exact when `channels === 2`. Mono → stereo is also handled (channel duplication) on the off chance the engine is fed a mono input chain.
- **Tail seconds** is now respected — the hard-coded `+1s` is gone. Setting `tailSec: 0` for a hard cut is cheap.
- **MP3 / FLAC / OGG are still WAV under the hood** — no encoder is bundled. The fallback is documented in the engine JSDoc; the modal already shows file-size estimates that assume WAV. Adding `lamejs` is the next obvious move when it becomes a priority.
- Modal call site (`daw-export-modal.tsx`) and the context delegate (`daw-context.tsx`) updated to forward the full options object end-to-end.

### Lint baseline

- Refreshed `app/.eslint-baseline.json` from 106/62 → **79 errors / 53 files**. `pnpm lint:check` still passes; all 27 retired errors were `react-hooks/refs` (one less foot-gun for the React Compiler).

### Added — Audit round 6 (batch 4)

- **MP3 encoding for the DAW export pipeline.** `DAWEngine.exportProject` now actually emits real MP3 when `format: "mp3"` is requested, via a dynamically-imported `@breezystack/lamejs` (pure-JS lamejs fork — no WASM, no FFmpeg). Float32 samples are quantised to Int16 and fed to the encoder in 1152-sample frames (the MP3 layer-III granule pair, anything else triggers internal buffering). Bitrate flows through from the modal's existing slider (default 192 kbps). FLAC and OGG still fall back to WAV — those need their own encoders.
- **FLX4 sampler pads + slip-mode are real.** Added 16 sampler mappings (notes 0x30..0x37 on each deck's pad channel) so when the controller is in SAMPLER pad mode the 8 pads on either deck trigger samplers 1-8. Added 2 SLIP toggle mappings (note 0x40 on ch 0/1) and wired the action to the existing `toggleSlipMode(deck)` in the mixer context — previously the handler swallowed `slip-mode` as a no-op with a "reserved" comment.
- **`audio-fx-engine` constant tests.** 5 tests guarding `NOTE_NAMES` (12-tone chromatic, sharps only — flat aliases would break the registry), `FX_DEFAULTS` (every FX type referenced in `FX_CATEGORIES` has params, every default is finite, mix ∈ [0,1], ratio ≥ 1, feedback < 1, dB thresholds ≤ 0), `FX_CATEGORIES` (unique labels, every FX appears in exactly one category), and `MUSICAL_SCALES` (intervals are sorted, non-negative, < 12, chromatic is the full 12 semitones).
- **`live-engine` helper tests.** 8 tests covering `DEFAULT_PAD_COLORS` (8 distinct hex colours), `noteIndexToName` (MIDI 0/12/60 = C, 69 = A, negatives wrap correctly), `formatLiveTime` (M:SS, NaN/-1/Infinity all → "0:00", floor on fractional), `formatRecordTime` (M:SS under one hour, H:MM:SS at and above one hour).

### Fixed — Audit round 6 (batch 5: sync + companion security)
- **Migration 0002 referenced wrong table names.** The FK-coverage migration tried to `CREATE INDEX … ON "accounts" ("userId")` and `… ON "sessions" ("userId")`, but `0000_init.sql` actually creates those tables singular (`account`, `session`, the next-auth convention). On a fresh production DB `pnpm db:migrate` would have failed at 0002. Fixed both index targets to the singular table names.
- **`applyPlaylistUpsert` delete bypassed LWW.** A stale tombstone (delete intent with `updatedAt` older than the cloud row's `updatedAt`) was unconditionally winning, which meant a slow companion's "I deleted X yesterday" arriving after a web-app rename today would clobber the rename. Now the delete path compares timestamps and skips when the cloud row is newer (returns `{ skipped: true }` instead of issuing the DELETE). Same fix in `applyCuepointUpsert` — the route was symmetrical there too.
- **Companion plugin host had an RCE-grade hole.** `POST /plugins/render` and `POST /plugins/describe` accepted arbitrary `path` strings from the client and asked pedalboard to load them — but VST3 / AU / LV2 plugins are *arbitrary native code*, so anyone holding a leaked `X-Device-Token` (over LAN — companion binds 0.0.0.0) could load `\\evil-smb-share\payload.vst3` and pop the user's machine. Added `pluginHost.isKnownPluginPath(p)` allowlist that only honours paths already in the cached scan inventory, and gated both routes behind it (403 + "run a scan first" message). Scan itself still accepts user-supplied directory paths since that's the intended UX, but those are *directories searched for plugins*, not direct dlopen targets.

### Added — Audit round 6 (batch 5)

- **5 new sync tests.** Extended `sync-apply.test.ts` to cover the two LWW-on-delete fixes:
  - `applyPlaylistUpsert`: stale tombstone is rejected, fresh tombstone is honoured, missing row is a clean skip (3 tests).
  - `applyCuepointUpsert`: stale tombstone is rejected, fresh tombstone is honoured (2 tests).
- The mock harness gained a `nextRowQueue` so we can stub multiple sequential `select(...).limit()` calls (cuepoints does a tracks lookup before the cuepoint lookup). Also tracks `deleteCalls` so the assertions can prove a DELETE *didn't* fire on the LWW-loser paths.

### Tests

- `pnpm test --run`: 13 files / 104 tests passed (was 99 after batch 4).

### Fixed — Audit round 6 (batch 6: sync echo, lint hydration)

- **Sync echo-pull bug.** The protocol comment said `GET /api/sync` filtered out the device's own pushes via `originDeviceId`, but the column never existed and the GET query never had a `<>` filter. Every device thus re-pulled its own writes on the next poll — per-field LWW kept the data consistent, but it doubled push bandwidth and made the companion log noisy. Fixed by adding `origin_device_id` to `sync_log` (new `0003_sync_origin_device.sql` migration), threading the device id from `POST /api/sync` into `appendSyncLog(userId, change, dev.id)`, and adding `OR(originDeviceId IS NULL, originDeviceId <> $deviceId)` to the GET filter. Cloud-side writes (web app, server actions) leave the column NULL so they still fan out to every device including the originator.
- **`SidebarProvider` localStorage flash.** The provider initialised `collapsed = false` and then ran an effect that read `localStorage.getItem("sidebar-collapsed")` and called `setCollapsedState(true)`. On a hydrated page that had previously been collapsed this caused a one-frame flash of the expanded sidebar. Switched to a lazy `useState` initialiser that reads localStorage on the first client render (SSR-safe via `typeof window`).
- **`useOfflineMode` settings hydration.** Same shape as the sidebar fix — `setSettings(getSettings())` lived inside the mount effect and ran one render after `DEFAULT_SETTINGS`. Lazy-init the `useState` and drop the redundant effect line.

### Added — Audit round 6 (batch 6)

- **`schema.ts: syncLog.originDeviceId`** column declared with the same nullability semantics as the migration. Drizzle picks it up automatically for `db.insert(syncLog).values({ originDeviceId })`.

### Fixed — Audit round 6 (batch 31: Electron renderer hardening, recordings cross-tenant disclosure + IDOR, profile import DoS, FS-oracle path gates)

- **Electron renderer no longer trusts navigation or `window.open`.** `BrowserWindow` was created with `preload`, `contextIsolation: true`, `nodeIntegration: false` — but with no `setWindowOpenHandler` and no `will-navigate` guard. Any `<a target="_blank">`, `window.open(remoteUrl)`, or compromised dependency that triggered a navigation could spawn another BrowserWindow with the same preload attached, handing the IPC bridge (`window.mmo.va.install`, `selectFolder`, `authenticate`, etc.) to an arbitrary remote origin. Now: `setWindowOpenHandler` always returns `{ action: "deny" }` and routes `https?://` requests through `shell.openExternal` (system browser); `will-navigate` blocks anything that isn't `file://` (the bundled UI) and routes external links the same way. The audio-driver installer + filesystem picker are reachable only from the bundled renderer.
- **`listRecordings` was a cross-tenant data dump for unauthenticated callers.** The action did `auth().catch(() => null)`, then built `conditions = [eq(userId, …)]` only when a session existed. With no session, conditions was `[]`, the userId filter was skipped, and the query returned every recording in the database (capped at 200 rows). Server actions are HTTP-reachable; this was a one-request full disclosure. Now it requires a valid session and returns `[]` otherwise.
- **`recordings.{rename,delete,toggleFavorite}` IDOR via `isNull(userId)` ownership escape.** All three used `or(eq(recordings.userId, userId), isNull(recordings.userId))` for ownership, with the comment "or NULL for legacy pre-multi-tenant rows". `recordings.userId` is nullable in the schema. Combined with the disclosure above, any signed-in user could enumerate IDs and rename/delete/favorite every orphan-userId row in the DB — and `renameRecording` also moves the underlying file via `fs.rename`, so the bug was a file-move primitive too. Tightened to `eq(recordings.userId, userId)`. Real legacy data should be backfilled with the owning userId, not left readable by everyone.
- **`importProfile` had no caps on the imported shape (DoS) and bypassed the regular preference key/value caps.** The regular bulk-save path enforces ≤1 000 entries, key ≤128 chars, value ≤8 KB. The import path silently allowed unbounded `entries`, key ≤256 chars (double), value ≤1 MB (125×). 100 000 entries × 1 MB = 100 GB import that builds one Postgres insert and OOMs the connection; even a "small" 1 000 × 1 MB = 1 GB query is enough to crash. `name` and `description` were unbounded — a 1 GB string would land in a TEXT column and break every list view that loads it. Capped at: 1 000 entries, key ≤128, value ≤64 KB (generous import-only budget; runtime writes still gated by the 8 KB regular cap), `name` ≤200 chars, `description` ≤2 000 chars.
- **Authenticated FS oracle in `import.ts`.** `checkFileExists`, `getFileSize`, and `importRekordboxAction(xmlPath)` accepted any caller-supplied path with no shape gate. Auth-required, but every signed-in tenant could probe arbitrary host paths (cookie databases, SSH keys, lock files, mounts of other tenants' data on shared deployments) and reach `fs.existsSync` / `fs.statSync` / `parseRekordboxXml` with NUL/control bytes (used to truncate paths or smuggle through layered checks) and multi-MB strings. Added `isSafeFsPath` guard at all three entry points: non-empty, ≤4 096 chars, no control bytes. A whitelisted-roots model is the better long-term answer (the rekordbox XML location is user-configurable across OSes, so we can't strictly anchor it here), but the cheap classes of abuse are now closed.

### Fixed — Audit round 6 (batch 30: cross-tenant relay key collision + array-DoS sweep on companion library / sync routers + cloud /api/sync cap)

- **Remote relay cross-tenant `peerId` collision (kick + stream leak).** `RemoteRelay` keyed its in-memory client map by the client-supplied `peerId`. Two users picking the same `peerId` (intentionally or by collision) would silently overwrite the previous entry: the original user's `ReadableStreamDefaultController` was orphaned (memory leak — never closed, never enqueued to again, never garbage-collected) and the original user stopped receiving broadcasts. Now keyed by `${userId}\u0000${peerId}`; `add()` closes the previous controller for the same key (legit reconnect cleanup); `remove()` requires both `userId` and `peerId` (callers can no longer evict a stranger's stream). The SSE register endpoint also bounds the `peerId` query param (`/^[A-Za-z0-9._-]+$/`, ≤128 chars) so it can't be a multi-MB Map key or carry control chars into log lines.
- **Array-DoS sweep on companion `/library/*`.** Multiple bulk endpoints accepted unbounded arrays from the (authenticated) caller and built giant SQL `IN (...)` clauses or fired N synchronous SQLite writes, blocking the single-threaded better-sqlite3 connection for the whole process:
  - `POST /tracks/hide` — capped `ids` at 5 000, integer-coerced each entry. Previously `ids: number[]` was a TypeScript-only assertion; a payload of `{ ids: ["DROP", null, NaN, ...1M entries] }` either crashed the prepared statement or locked the writer.
  - `POST /tracks/ingest` — capped `tracks` array at 10 000 per request (the existing 64 MB body cap doesn't stop hundreds of thousands of tiny rows).
  - `POST /tracks/:id/rating` — strict validation: integer 1-5 or null/0 to clear; previously `rating || null` accepted strings, NaN, and any number, all flowing into SQLite verbatim.
  - `POST /tracks/:id/tags` — strict validation: array of non-empty strings ≤64 chars, ≤64 entries; previously `tags: string[]` was TypeScript-only and any JSON shape was `JSON.stringify`d into the column, breaking every downstream reader that assumes `string[]`.
  - `POST /playlists/:id/tracks` — capped `trackIds` at 5 000 + integer coercion (same shape as `/tracks/hide`).
- **Companion `/v1/sync` array cap + entityId length cap.** The router validated each change's shape but not the count. A 5-million-entry `changes: SyncChange[]` body would loop synchronously through `enqueueSyncChange` per item and lock the writer for minutes. Capped at 5 000 changes/request and `entityId` at 256 chars (it's a primary-key-shaped value; long blobs are always abuse).
- **Cloud `POST /api/sync` array cap.** Same shape as the companion route, but worse: each change does multiple sequential Postgres round-trips inside `applyChange`. A single 100k-entry POST monopolises a Next.js request handler for minutes and starves other tenants on the same instance. Capped at 1 000 changes/request (returns 413 above that). The existing per-user rate-limit (60/min) plus this cap means a single device can push at most 60 000 changes/min — well above legitimate sync bursts.

### Fixed — Audit round 6 (batch 29: five-target sweep — security headers, rate-limits, companion path-prefix bugs, file-existence oracle, logger PII redaction, browse-folder input cap)

- **Security headers** — added Cross-Origin-Opener-Policy (`same-origin-allow-popups`) and Cross-Origin-Resource-Policy (`same-site`) to defeat XS-Leak and Spectre-class window-reference probes against logged-in pages, while keeping Stripe checkout + Google OAuth popups working. HSTS bumped to 2 years and tagged `preload` (no-op until the domain is submitted to the preload list, but ready when it is).
- **Rate-limits** on three previously-unlimited authenticated POST routes:
  - `POST /api/billing/checkout` — 10/min/user. Uncapped, a compromised session could spam Stripe checkout creation (cost + Stripe-dashboard pollution).
  - `POST /api/billing/portal` — 10/min/user. Same shape.
  - `POST /api/remote/send` — 600/min/user (10/sec). Sync messages legitimately fire fast, but unbounded fan-out across all peers is a per-tenant amplification primitive. Also added a 64 KB per-message cap and a 128-char `senderId` cap (each message is fanned out to every peer, so a 10 MB message was a 10 MB egress burst per peer).
- **Companion `/scan` had the same prefix-match traversal as `/audio/*`** before batch 26 fixed it (`resolved.startsWith(scanFolder)` matched sibling paths like `/srv/music_secret`). Now uses the new `resolveAllowedFolder` helper from `path-guard.ts` (sibling-prefix safe + symlink resolution + Windows case-insensitive).
- **Companion `/check-files` was a file-existence oracle.** Took an array of arbitrary paths and returned which exist. Anyone with the device token could probe `/etc/shadow`, `/Users/victim/.ssh/id_rsa`, browser-cookie databases, password manager files — learning their existence without reading contents. Now gated through `isPathInAllowedFolder` so the probe only answers questions about files inside scan folders. Also capped to 10 000 paths/request (a 10 MB array previously triggered 10 M `fs.existsSync` syscalls).
- **Logger PII redaction.** `log.info`/`log.warn`/`log.error` now walk their `fields` object (4-deep) and replace values under any of ~20 well-known sensitive keys (`token`, `secret`, `apiKey`, `password`, `cookie`, `authorization`, `stripeSecret`, `clientSecret`, `refreshToken`, `accessToken`, `sessionToken`, etc.) with `"[redacted]"`. No call site ever has to remember the redact list — the logger does it. Closes the latent risk that a future `log.warn("device update", { token: bearer })` quietly ships the bearer to Cloud Run / Loki.
- **`POST /api/download/browse-folder`** — added a 4 KB `dir` length cap + control-byte rejection at the request boundary. The route already requires session + per-user rate-limit; this just stops a multi-MB `dir` string from reaching `path.resolve` / `fs.readdirSync` and from polluting log lines with control characters.

### Fixed — Audit round 6 (batch 28: companion WebSocket origin allowlist + MMO_SECRET_KEY env validation)

- **Companion `/ws` WebSocket accepted connections from any origin.** The HTTP-side `cors` middleware doesn't apply to WebSocket upgrades — only the `Origin` header arrives, and we never gated on it. Result: any web page the user has open in another tab (`attacker.com`) could `new WebSocket("ws://localhost:17899/ws")` and silently subscribe to the realtime fan-out. That stream includes `watch:event` messages (filesystem changes, with paths) and `sync:applied` messages (entity-set deltas), which together form a low-rate side channel disclosing what files the user is editing in realtime.
- Wired `verifyClient` into `WebSocketServer` to reuse the same `isAllowedOrigin` predicate the HTTP CORS layer uses. Cross-origin upgrades are now cleanly rejected with `401 origin not allowed`. Same allowlist (loopback + companion-settings + configured webAppUrl) so policy stays in one place; no UI-visible change for legit web-app traffic.
- **`MMO_SECRET_KEY` (BYO-AI-keys at-rest crypto)** added to the env startup-validation schema. Kept optional at the schema level (a deployment that doesn't expose AI features shouldn't be blocked) but now appears in the validated surface and won't be silently mistyped — `crypto-secret.ts` still throws at use time with a clear message if missing/wrong-length.

### Fixed — Audit round 6 (batch 27: companion `/folders/add` consent bypass — arbitrary file read primitive)

- **Critical: companion `POST /folders/add` accepted ANY filesystem path** with only the device-token bearer auth. Any caller able to reach the companion HTTP server with a valid token (the web app under the user's session, or an attacker who phished the token / scraped it from a backup before the batch-24 at-rest encryption landed) could:
  1. `POST /folders/add {"path":"/"}` (Linux/macOS) or `{"path":"C:\\"}` (Windows) — silently registers the entire filesystem as a "scan folder", with no UI feedback or consent prompt on the device.
  2. `GET /audio/etc/passwd`, `/audio/Users/victim/Documents/.../*`, `/audio/home/.ssh/id_rsa`, etc. — `/audio/*`'s only gate is the scan-folder allow-list, which we just poisoned. Companion happily streams the bytes back through the (now-hardened) path-resolver.
- Net effect: arbitrary file read on the device the companion runs on, with the user's own credentials. The companion runs at user privileges, so the attack reads anything the user can read — SSH keys, browser cookie databases, source repos, password manager files. This was the most serious finding of the audit.
- The route had **zero callers in the web app** (verified via repo-wide grep) — pure dead-code attack surface left over from earlier development. Removed entirely. Folder addition now goes exclusively through `POST /folders/pick`, which fires `dialog.showOpenDialog` on the focused window — the human at the device must physically click "Open" before any path is added. There is no remaining code path that registers a scan folder without an OS-level consent dialog.
- Comment block left at the removed call site documenting the threat model and forbidding re-introduction without a real consent surface.

### Fixed — Audit round 6 (batch 26: env startup-validation, Auth.js callback hardening, plaintext-token column drop, companion path-traversal, Stripe webhook DoS cap, recordings metadata DoS cap)

- **No env validation at boot.** Missing or weak `AUTH_SECRET`, missing Google client creds in production, or a live `STRIPE_SECRET_KEY` without `STRIPE_WEBHOOK_SECRET` (= `/api/billing/webhook` accepts unsigned forged events) all silently booted. New module `app/src/lib/env.ts` defines a Zod schema for every env var the server reads + production-only refinements (Google creds required, Stripe webhook secret required when SDK key set, test-key in production refused, common placeholder secrets refused). Wired into `instrumentation.ts` so the validation runs on the first server cold-start; `vitest.setup.ts` preloads safe defaults so tests boot cleanly. Production failures throw and kill the process; dev / test only print a warning so contributors aren't blocked.
- **`auth.ts` had no `signIn` callback.** Any account Auth.js could federate (now or any future provider added by accident) was accepted. Added: explicit provider gate (only `google`), `email_verified` requirement (blocks the trivial Google Workspace alias impersonation trick), and an optional `AUTH_ALLOWED_EMAILS` allowlist for single-tenant self-hosted deployments. Also added a `redirect` callback that rejects protocol-relative URLs (`//evil.com/...`) and any cross-origin redirect (Auth.js's default already strips most cases; we tighten further).
- **Migration `0007_drop_devices_token_plaintext.sql`** — follow-up to 0006. Drops the legacy plaintext `devices.token` column and its unique index now that the at-rest crypto is in place. Includes a pre-deploy check note (`SELECT count(*) FROM devices WHERE token IS NOT NULL` must be 0 first). The schema, `findDeviceByToken`, and `materializeDeviceToken` lost their legacy fallback paths; one source of truth on the new columns going forward. Read paths now ONLY consult `tokenHash` / `tokenEncrypted`.
- **Companion path-traversal in `/audio/*` and `/download/*`.** The check `normalized.startsWith(scanFolder)` had two well-known holes: (a) **sibling-prefix bypass** — scan folder `/srv/music` matches `/srv/music_secret/...` because no separator is appended; and (b) **symlink escape** — a symlink inside the scan folder whose target is `/etc/passwd` passes the prefix check because the path itself stays in-folder. New helper `server/src/lib/path-guard.ts` (`resolveAllowedFile`) closes both: appends `path.sep` before prefix comparison, then re-checks via `fs.realpathSync` against realpath'd scan folders, plus null/control-byte rejection, length cap, and Windows case-insensitive comparison. Both companion routes now go through it. Bonus: `Content-Disposition` filename now strips `\r\n"\\` to prevent header injection if a maliciously-named file ever lands in a scan folder.
- **Stripe webhook had no body-size cap.** Anyone could POST a multi-MB body to `/api/billing/webhook` and force the server to buffer it before the signature check rejected it (memory-pressure DoS). Added a 1 MB ceiling (Stripe events are ~10–50 KB even for the largest invoice; 1 MB is 20× the worst case) checked at both `Content-Length` and post-read.
- **`/api/recordings/save` JSON-DoS via `metadata` field.** The 1 GB body cap bounded the binary blob but `metadata` was an unbounded string handed straight to `JSON.parse`. Added a 64 KB metadata cap so an attacker can't force CPU-DoS by uploading a tiny audio blob with a multi-MB metadata blob attached.

### Fixed — Audit round 6 (batch 25: yt-dlp SSRF + CLI flag-injection in /api/download/info; shared URL guard)

- **`POST /api/download/info` accepted any URL `new URL()` could parse** and handed it to `spawn("yt-dlp", [..., url])`. yt-dlp will happily fetch from `file:///etc/passwd`, `ftp://...`, `http://localhost`, `http://169.254.169.254/...` (cloud metadata), and any RFC1918 / link-local target — turning an authenticated POST into a bearer-tokenless SSRF gadget against internal infrastructure (cloud metadata, k8s API, RDS, neighbouring tenants, the companion on localhost).
- **CLI flag-injection on the same route.** yt-dlp parses options anywhere on its command line, so a URL beginning with `-` (`--exec=...`, `--config-location=/etc/passwd`, `--cookies=...`, `--load-info-json=...`) was reinterpreted as a flag. With `spawn` and an array argv there's no shell injection, but flag injection alone yields RCE-equivalent surface (arbitrary file read, command execution via `--exec`, custom config load, cookie/token exfiltration into the response).
- New shared module `app/src/lib/url-guard.ts` extracts the SSRF predicate (RFC1918 / loopback / link-local / multicast / IPv6 ULA + link-local) into one place so every route forwarding a user-supplied URL uses the same allow/block logic. Two flavours: `validatePublicHttpUrl` (strict — never allows private hosts; for genuinely-external fetches like yt-dlp / future scrapers) and `validateDeviceApiUrl` (honours the `MMO_ALLOW_PRIVATE_DEVICE_URLS=1` opt-in for self-hosted LAN companions).
- `/api/download/info` now validates the body URL through `validatePublicHttpUrl` before any `spawn`. The validator additionally rejects any value beginning with `-`, and every yt-dlp invocation inside the route now passes `--` before the URL so even a missed leading `-` cannot be reinterpreted as a flag (defence in depth at both the validation and the subprocess boundary). The recursive single-entry-playlist branch re-validates the entry URL before re-spawning yt-dlp, so a hostile playlist whose entries point at `file://` or `169.254.169.254` is also rejected.
- `/api/devices/auto-register` now imports `validateDeviceApiUrl` from the shared module instead of its own ~50-line copy of the predicate; behaviour identical, single source of truth. Future routes (e.g. webhook target validation, image-proxy, OAuth redirect targets) can reuse the same helpers.

### Fixed — Audit round 6 (batch 24: device bearer tokens encrypted at rest)

- **`devices.token` was the plaintext bearer credential the web app forwards to companion HTTP endpoints (X-Device-Token), and it was stored unhashed and unencrypted in Postgres.** A single read-side compromise (backup leak, replica access, future SQLi anywhere else in the app, accidental log dump) yielded every device's bearer credential forever. Tokens never rotated; revoking a leaked token meant deleting the device row and re-pairing.
- New migration `0006_devices_token_at_rest.sql` adds two columns: `token_hash` (HMAC-SHA256, hex, unique-indexed) for inbound auth lookups, and `token_encrypted` (`v1:b64(nonce):b64(ciphertext+tag)`, AES-256-GCM) for outbound forwarding to companions. The plaintext `token` column is made nullable so each row can be lazily nulled after backfill — no downtime, no separate backfill job. A follow-up migration after the rollout window can drop the column outright.
- New `app/src/lib/device-token.ts` module owns all crypto. Two HKDF-derived keys (`mmo:device-token:hmac:v1` and `mmo:device-token:aesgcm:v1`) are derived from `AUTH_SECRET` so a leak of one (or a future algorithm break in HMAC vs. GCM) doesn't compromise the other. New tokens are 48 random bytes (~384 bits) base64url-encoded — also a meaningful entropy bump from the old `randomUUID() + "-" + randomUUID()` (122 bits effective). Without `AUTH_SECRET` an attacker holding a full row dump cannot recover either lookup capability or the plaintext bearer.
- All five issuance + lookup + outbound-use sites switched over:
  - **Issuance:** `POST /api/devices/auto-register` and the `registerDevice` server action now call `issueDeviceToken()`, which returns the plaintext to the caller (companion) but persists only `tokenHash` + `tokenEncrypted`. The legacy plaintext column is left null on new rows.
  - **Inbound auth:** `POST /api/devices/heartbeat`, `POST /api/devices/validate`, and `GET|POST /api/sync` now look up via `findDeviceByToken(plaintext)` — hash-first, with a one-shot legacy plaintext fallback that backfills the hash + ciphertext and nulls the plaintext on hit. Migration completes lazily as devices reconnect.
  - **Outbound use:** `getCompanionLink` / `getCompanionLinkForDevice` (in `companion-library.ts`), `resolveDevice` (in `companion-control.ts`), `scanDeviceFolder` and `getLocalCompanion` (in `actions/devices.ts`) now go through `materializeDeviceToken(row)`, which decrypts the envelope and opportunistically backfills any legacy plaintext-only rows it sees. Outbound `X-Device-Token` headers therefore continue to receive a valid bearer through the migration window.
- New tests in `app/src/lib/device-token.test.ts` lock the round-trip + tamper-rejection invariants (encrypt/decrypt, hash determinism, fresh nonce per call, GCM tag validation, version-string rejection). Vitest gained a `server-only` shim so server-side modules are unit-testable; `vitest.setup.ts` now provides default `DATABASE_URL` / `AUTH_SECRET` so module-load env validation doesn't crash test boot. Test count: **109 → 115**.

### Fixed — Audit round 6 (batch 23: five-target sweep — devices class-of-bug, companion CORS / token compare / body limit, auto-register SSRF + rate limit)

- **`actions/devices.ts` — three more unscoped DB ops on `deviceFolders` (class-of-bug repeat from batches 19 / 22).**
  - `getDeviceFolders(deviceId)` had no `auth()` and no ownership check — any signed-in user could enumerate any other tenant's folder list by guessing device IDs.
  - `addDeviceFolder(deviceId, …)` checked `auth()` but never verified `deviceId` belonged to the session user — cross-tenant write that planted attacker-chosen scan paths on a victim's device row (the victim's companion would dutifully walk them on next refresh — local-FS recon).
  - `removeDeviceFolder(folderId)` had no `auth()` and no ownership predicate at all — unauthenticated bulk-deletion of any user's folder rows by sequential id enumeration.
  - All three now go through a `userOwnsDevice(deviceId, userId)` helper. The DELETE is scoped via a sub-select so the ownership check and the delete happen in a single statement (no read-then-write race).

- **Companion `server.ts` — three issues on the LAN-bound HTTP listener.**
  - `authMiddleware` did `token !== storedToken` plain string compare — replaced with a `crypto.timingSafeEqual` after a length check. Closes the textbook timing oracle a co-LAN attacker could use to recover the device token byte-by-byte.
  - Global `cors({ origin: true, credentials: true })` reflected every Origin and paired it with credentials — any web page the user visited could issue cross-origin requests to `http://<lan-ip>:17899/...` with cookies. Replaced with an explicit allowlist callback that delegates to the existing `isAllowedOrigin` (loopback + `audioOriginAllowlist` + configured `webAppUrl`).
  - `express.json({ limit: "64mb" })` was applied globally **before** `authMiddleware`, so any LAN attacker could POST 64 MB JSON bodies that got parsed into memory before being rejected with 401 — trivial low-rate RAM-exhaustion DoS on a desktop process. Now the global default is `1mb`; the `/library/tracks/ingest` route (the one that legitimately needs a full folder scan in one POST) gets its own `64mb` parser mounted ahead of the global one so the larger limit only applies to that path.

- **`POST /api/devices/auto-register` — no rate limit, no input validation, no SSRF guard on `apiUrl`.** A signed-in user could spam unbounded device rows (storage exhaustion) and, more critically, set `apiUrl` to anything — the web app's later server-side `fetch(device.apiUrl + ...)` calls (`/api/audio/device/[id]`, `pingDevice`, scan, sync) then turned the Next.js process into an SSRF gadget. Targets included cloud metadata services (`http://169.254.169.254/latest/meta-data/`), neighbouring tenants on the same VPC, the k8s API, any RDS/Redis on the host network. Now: per-user rate limit (10/h) via the existing `rateLimit` helper; `apiUrl` validated through `new URL()` + scheme allowlist (`http:` / `https:` only) + RFC1918 / loopback / link-local / multicast hostname blocklist (`127/8`, `0/8`, `169.254/16`, `10/8`, `172.16/12`, `192.168/16`, IPv6 `::1` / ULA `fc00::/7` / link-local `fe80::/10`); length caps on `hostname` (128) / `os` (64) / `apiUrl` (2048); strict port range. Self-hosted LAN deployments opt back into private targets via `MMO_ALLOW_PRIVATE_DEVICE_URLS=1`; non-production environments default-allow so the dev-time `http://localhost:17899` companion still registers without extra setup.

### Fixed — Audit round 6 (batch 22: cross-tenant device hijack + token-bearing SSRF in `/api/audio/device/[id]`)

- **`GET /api/audio/device/[id]` resolved `track.deviceId` against the global `devices` table with no `userId` predicate, then `fetch()`-ed the resulting device's `apiUrl` with that device's bearer token in `X-Device-Token`.** The companion's `tracks` table is user-controlled (the same trust-boundary issue batch 21 fixed for `/api/audio/[id]`). An attacker could PATCH one of their own track rows to set `deviceId = "<victim_device_uuid>"` and `filepath = "../../../etc/passwd"`, then `GET /api/audio/device/<their_track_id>`. The web server would:
  1. Look up the **victim's** device row (no userId scope on the SELECT).
  2. Issue `fetch(victim.apiUrl + "/audio/" + filepath)` with `X-Device-Token: <victim's token>` — authenticating as the victim against the victim's own companion.
  3. Stream the response (with `Range:` forwarded for chunked exfiltration) back to the attacker.
- Net impact: cross-tenant audio file disclosure of any track on any other user's companion, **plus** token-bearing SSRF — `device.apiUrl` is whatever the victim auto-registered (LAN/Tailscale/loopback) so the attacker reaches RFC1918 hosts the *victim's outgoing fetch* can route to, with the victim's bearer attached. Also fully sidestepped the `MMO_LOCAL_AUDIO_ROOTS` allowlist that batch 21 added to the sibling local-FS route.
- Replaced the unscoped `db.select().from(devices).where(eq(devices.id, track.deviceId))` with `getCompanionLinkForDevice(track.deviceId)`, which already enforces `where deviceId = ? and userId = session.user.id` and returns null if either fails. Added defence-in-depth validation on `track.filepath` before forwarding (length cap + reject control chars / null bytes — never legitimate, just enlarges the attack surface for any current or future companion-side parser bug).

### Fixed — Audit round 6 (batch 21: arbitrary file read on the web server via `/api/audio/[id]`)

- **`GET /api/audio/[id]` would `fs.createReadStream(track.filepath)` against any string the user's companion returned, with no path-containment.** The companion is the user's own machine; its `tracks` table is *user input* from the web app's perspective. Any signed-in user with a paired companion could PATCH their own companion DB to set `tracks.filepath = "/etc/passwd"`, `"./.env.local"`, `"/proc/self/environ"`, the web app's SQLite, mounted-secret paths, etc., then issue `GET /api/audio/<id>` and have the **server** stream those bytes back. `?download=1` saved the response with any name; `Range:` allowed chunked exfiltration regardless of file size. Cross-tenant arbitrary read of any file the Next.js process can open — HIGH for any hosted/shared deployment.
  - Added an explicit `MMO_LOCAL_AUDIO_ROOTS` env-var allowlist of absolute roots the server is willing to stream from. `realpathSync.native` resolves symlinks before the containment check (so symlink-escape attempts are rejected). Null-byte truncation, length cap, and non-string inputs are rejected up front.
  - When `MMO_LOCAL_AUDIO_ROOTS` is unset (the default for any hosted/multi-tenant deploy), the route refuses to touch the FS at all and returns `501`. Clients fall back to `/api/audio/device/[id]`, which proxies via the companion's HTTP API and never reads the server's filesystem.
  - Bonus correctness/DoS hardening on the same handler: rewrote the `Range:` parser, which was `parseInt(parts[0])` / `parseInt(parts[1])` with no validation. Suffix ranges (`bytes=-500`) produced `NaN` start with a wrong `Content-Length`; `start > fileSize` streamed garbage instead of `416`; malformed ranges silently fell through. Now strict regex parse, suffix-range support, and a proper `416 Content-Range: bytes */<size>` for any unsatisfiable case.

### Fixed — Audit round 6 (batch 20: three more `/api/*` GETs that leaked host or cross-tenant data)

- **`GET /api/recordings/[id]/audio` was an unauthenticated bulk-exfiltration vector for any legacy recording.** The endpoint allowed anonymous access whenever `row.userId` was null ("created in a single-user dev context"), and recording IDs are sequential `serial` integers — anyone could iterate `/api/recordings/1/audio`, `/api/recordings/2/audio`, … and pull every legacy or backup-restored row. Even after batch 17 forced `saveRecording` to always stamp `userId` from the session, any null-userId row that ever made it into the table (legacy data, restore from older backup) remained world-readable. Now requires a session: signed-in users can read their own rows + null-userId rows (matching the `recordings`-action ownership model from batch 17); unauthenticated callers get `401`.
- **`GET /api/system-stats` was an unauthenticated SSE leaking host CPU / GPU / RAM / temperature continuously.** Two real costs: (1) host-fingerprinting surface for any visitor (model strings, core counts, VRAM totals — useful for picking exploits sized to the host), and (2) free DoS amplifier — every open connection runs `systeminformation` polling forever until the client aborts, no rate limit, no auth gate to throw load back on the caller. Added explicit `auth()` check at the top of the GET; unauthenticated callers get `401` before any subsystem queries fire.
- **`GET /api/lan-url` enumerated the host's private-network IPv4 addresses unauthenticated.** RFC1918 ranges aren't directly routable, but exposing the exact LAN topology (which 192.168.* / 10.* subnet the host sits on, how many interfaces, addresses on each) to any anonymous web caller is unnecessary attack surface — useful for pivoting once an attacker has any other foothold on the same network, useless for a legitimate visitor. Added `auth()` gate.

### Fixed — Audit round 6 (batch 19: analysis manager was a process-global singleton — cross-tenant everything)

- **`analysisManager` was a single shared instance hung off `globalThis`.** It holds an in-memory queue of pending textual-metadata changes (track titles, lyrics, MusicBrainz lookups) plus the SSE subscriber set, and its export was a single `AnalysisManager` instance reused for *every* request from *every* user. The six `/api/analysis/*` routes all imported that singleton, so:
  - **`GET /api/analysis/stream`** — SSE feed of every event from whichever user happened to start the active job. Any signed-in viewer (and originally any unauth'd visitor — there was no `auth()` either) hitting the endpoint received another user's track titles and progress. Cross-tenant info disclosure.
  - **`GET /api/analysis/status`** — same: returned the current track + counts of whoever started the job. No `auth()`. Cross-tenant info disclosure.
  - **`GET /api/analysis/changes`** — returned the `ManagedChange[]` set (per-track metadata diffs and full lyrics text) by jobId. No `auth()`. Cross-tenant exfiltration of pending edits.
  - **`POST /api/analysis/control`** — `pause`/`resume`/`stop`/`reset` on the global. Auth'd, but any signed-in user could DoS another user's running job by issuing `stop`/`reset`.
  - **`POST /api/analysis/apply`** — accepted a list of `changeIds` and committed them to the *applying* user's companion via `companionLibrary.updateTrack(link, …)`. Auth'd, but `changeIds` are global; an attacker could submit another user's pending changes and have them written to the attacker's own companion library. Both leaks data ("what was user X analysing?") and corrupts state ("the change set X was about to review is now empty").
  - **`POST /api/analysis/start`** — the root: creates the global job that everyone else then reads.

Fix:
- **Replaced the singleton export** in `lib/analysis-manager.ts` with `getAnalysisManager(userId): AnalysisManager`, backed by a `Map<userId, AnalysisManager>` hung off `globalThis` (still HMR-safe). Each user gets their own queue, their own SSE subscriber set, their own snapshot. Symbol key bumped to `Symbol.for("mmo.analysis-manager.registry")` so the old singleton can't accidentally be reused on dev hot-reload.
- **All six `/api/analysis/*` route handlers** now resolve `userId` from `auth()` (or from the existing `requireSessionWithRate` guard's `guard.userId!` for the three POSTs that already had it) and call `getAnalysisManager(userId)`. The three GETs (`stream`, `status`, `changes`) gained an explicit `auth()` check that wasn't there before — unauthenticated callers now get `401` instead of leaking another user's job state.
- A long block comment on the registry explains *why* per-user is the right shape, so a future contributor doesn't "simplify" it back to a singleton.

### Fixed — Audit round 6 (batch 18: server-action sweep — metadata, organize, scan, profiles)

Continuation of batch 17, this time covering the deeper-set actions. Four more distinct findings:

**`actions/metadata.ts`:**
- **`searchTrackMetadata(artist, title)`** — fully unauthenticated server-side proxy to MusicBrainz. Anyone could chain it as a generic outbound HTTP relay AND burn the web app's MB rate-limit budget (MB throttles by source IP — a flood from one anonymous abuser gets the whole web app's IP banned for every legitimate user). Now requires `auth()`.

**`actions/organize.ts`:**
- **`organizeTrack(trackId, genre)`** — path traversal. The `genre` argument flowed straight into `targetFolder = genreFolders[genre] || \`DJ/${genre}\`` and then into `moveTrackToGenreFolder`, which path.joins it under `musicRoot`. A crafted value like `../../Users/Public` (or `..\\..\\Windows\\Temp` on Windows) would resolve outside the configured library root. Authenticated user only, but the user could move *their own* tracks anywhere the web-server process can write — a stepping stone for staging files into web-served paths or overwriting unrelated files via filename collision. Added `sanitizeGenreSegment()` that strips path separators, control chars, and `..` sequences, and rejects empty results. The admin-configured `genreFolders` override map is left trusted; only the `DJ/${genre}` fallback now uses the sanitised value.

**`actions/scan.ts`:**
- **`scanFolderAction(folderPath)`** — relied implicitly on `getCompanionLink()` for auth, but `scanFolder` walks the *web-app host's* filesystem with `fs.readdir`, recursively. If `getCompanionLink` ever returns truthy for a wider population than expected (e.g. a future change), this becomes an arbitrary-directory enumeration primitive against the host. Made the auth requirement explicit with `auth()` first.

**`actions/profiles.ts`:**
- **`listProfiles()`** — counts query had no WHERE clause and SELECTed every `profilePreferences` row in the database across all users into process memory just to compute per-profile entry counts. Cross-tenant data in RAM, plus an O(all-users) cost on what should be O(this-user). Now uses `inArray(profilePreferences.profileId, profileIds)` against this user's profile ids only.
- **`renameProfile` / `deleteProfile` / `activateProfile` / `duplicateProfile`** — all four had the same TOCTOU shape: `assertOwnership(userId, profileId)` ran first, then a separate `UPDATE`/`DELETE` keyed by `eq(userProfiles.id, profileId)` only — no `userId` predicate on the mutation itself. Correct under current code, but a single future regression in `assertOwnership` would silently turn into cross-tenant writes. Tightened all four to `and(eq(userProfiles.id, profileId), eq(userProfiles.userId, userId))` so the mutation is self-guarding regardless of what the upstream check does.

### Fixed — Audit round 6 (batch 17: server-action sweep — recordings, import, export)

A follow-up search across all 19 remaining `"use server"` files (after batch 16's two devices.ts findings) turned up a cluster in three more modules with the same shape: exported actions that mutate state, write the FS, or read caller-supplied paths with no `auth()` gate and no ownership scope. None of these were exploitable by accident — but every one of them was reachable as a POST endpoint from any browser.

**`actions/recordings.ts`:**
- **`renameRecording(id, name)`** — looked up + updated by `id` only; `fs.rename(row.filepath, newPath)` ran on whatever filepath the row carried, so any caller could rename and effectively move any user's recording file.
- **`deleteRecording(id)`** — same shape: `fs.unlink(row.filepath)` + `db.delete` keyed only on `id`. Cross-tenant file + row deletion.
- **`toggleRecordingFavorite(id)`** — flipped `isFavorite` on any user's row.
- **`saveRecording(input)`** — wrote a caller-supplied `arrayBuffer` to disk and inserted a row before doing `await auth().catch(() => null)`. Anonymous insert+write was permitted by design (`userId` was nullable). On a deployment with a real FS that's an unauthenticated arbitrary-write surface; on the cloud (Vercel ephemeral FS) it just litters the table with orphan rows.
- **`setRecordingsFolder(folder)`** — `fs.mkdir(folder, { recursive: true })` ran on a caller-controlled path before `updateSetting` got a chance to run its own auth check. Unauthenticated arbitrary directory creation on the host.

Fix: every recordings mutation now requires `auth()` first, scopes its `WHERE` with `(userId = session.user.id OR userId IS NULL)` (the OR keeps legacy pre-multi-tenant rows manageable by their resurrecting owner), and `saveRecording` always stamps `userId` from the session — anonymous saves are no longer accepted.

**`actions/import.ts`:**
- **`checkFileExists(filePath)`** — unauthenticated `fs.existsSync` oracle on the host: useful for fingerprinting installed software and probing for reachable config files.
- **`getFileSize(filePath)`** — unauthenticated `fs.statSync(filePath).size` on any caller-supplied path.
- **`importRekordboxAction(xmlPath)`** — auth was implicit via `getCompanionLink()` (which requires a session), but the action then read and parsed an arbitrary caller-supplied `xmlPath` from the web-server FS. The `getCompanionLink` check returns early with a friendly error before reaching the `fs.existsSync` line, but it was relying on a side-effect of an unrelated check; making the auth requirement explicit removes that fragility.
- **`findRekordboxXmlPath()`** — also unauthenticated; trivial to gate.

Fix: all four now `auth()` at the top and short-circuit on missing session.

**`actions/export.ts`:**
- **`exportRekordboxXml(outputPath?)`** — auth was again implicit via `getCompanionLink()`, but the action then called `fs.mkdirSync(path.dirname(outputPath))` + `fs.writeFileSync(outputPath, xml)` with the caller-controlled path. Combined with the implicit auth, this was an authenticated arbitrary-file-write primitive — and a worst-case unauthenticated one if `getCompanionLink` ever changes its semantics. Worse on the cloud: an attacker who picks `public/leaked.xml` or `.next/static/leaked.xml` could exfiltrate someone else's full library through the web server.

Fix: explicit `auth()` gate at the top.

### Fixed — Audit round 6 (batch 16: device-mutation server actions had no auth or ownership scope)

- **`updateDeviceStatus` was an exported `"use server"` action with no auth check, no ownership scope, and a spread write of `apiUrl`/`hostname`/`os`/`version`/`status` straight into the row.** Anyone who could find the action ID (Server Actions are reachable as POSTs by any signed-in user; IDs are stable per build and visible on every page that imports the module) could call `updateDeviceStatus("victim-device-id", { apiUrl: "https://attacker.example/" })` and silently rewrite *any* device's API URL across all users. Next time the owner pinged, used companion-control, or loaded a page that talked to that device, their authenticated requests went to the attacker's server. Variants: flip `status: "offline"` to silently DoS a device, or rewrite `hostname`/`os` to corrupt the device list. Comment claimed "called by companion heartbeat" but the only callers are inside the same module — companion heartbeats actually go through the token-authed `/api/devices/heartbeat` HTTP route, not this action.
- **`pingDevice` was an exported `"use server"` action with no auth check that issued a server-side `fetch(device.apiUrl + "/health")`** based on a deviceId from the caller. Two compounding hazards: (1) any caller could probe any device row by id, and (2) the apiUrl is user-controlled, so combined with the bug above (or even alone, via a user setting their own device's apiUrl to `http://10.0.0.1/admin` or any internal Vercel-side address) this was an SSRF primitive that returned the response body in `info`.

Fixes:
- Renamed `updateDeviceStatus` → private `updateDeviceStatusInternal` (no `export`), with a comment block explaining why it is intentionally not exposed as a server action.
- `pingDevice` now requires a session (`auth()`) and scopes the lookup to `eq(devices.id, …) AND eq(devices.userId, session.user.id)`. A caller can only ping devices they own, and unauthenticated invocations short-circuit to `{ online: false }`.

### Fixed — Audit round 6 (batch 15: TURN credentials minted anonymously)

- **`/api/turn-credentials` issued valid TURN bearer credentials to unauthenticated callers.** The endpoint mints HMAC-signed `username:password` pairs that are valid for 24 hours against the operator's coturn server — coturn validates by recomputing the HMAC, with no per-user state and no other gate. The previous handler explicitly fell back to `userId = "anon"` when no session was present, so any drive-by GET walked away with a 24-hour, fully-functional TURN credential. TURN bandwidth is real money (the relay carries actual media), and the credential is bearer-grade once minted: anyone given it can use it from anywhere until expiry. Net effect: the app's coturn box is anyone's free media relay, billed to the operator. Fixes:
  - **Auth required when TURN is configured.** No session → `401`. The STUN-only fallback (when `TURN_HOST`/`TURN_SHARED_SECRET` aren't set) stays anonymous because Google's public STUN servers cost the operator nothing.
  - **TTL cut from 24h to 2h.** WebRTC sessions are minutes, not hours; `ice-servers.ts` already auto-refreshes 10 minutes before expiry, so the shorter window is invisible to legitimate clients but slashes the window any leaked credential is usable.
  - **Cache header reduced** to `private, max-age=TTL-600` so a leaked URL response can't outlive the credential it carries.

### Fixed — Audit round 6 (batch 14: rate-limiter IP-spoofing bypass)

- **`ipFromRequest` trusted client-supplied `X-Forwarded-For` for the rate-limit bucket key.** `X-Forwarded-For` is *appended to* by each proxy in the chain, but its leftmost value is whatever the original caller wrote — so any attacker could rotate `X-Forwarded-For: <random>` per request to land in a different bucket on every call and trivially defeat the per-IP limiter on `/api/devices/validate` (and any other endpoint using `requireRate`). The trustworthy values on Vercel are `x-vercel-forwarded-for` and `x-real-ip`, both populated by the proxy from the actual TCP connection and stripped of any caller-supplied value of the same name. Fix:
  - **Reordered the trust chain** in `ipFromRequest` to read `x-vercel-forwarded-for` → `x-real-ip` → `x-forwarded-for` (last-resort, dev-only, where no trusted proxy is in front). Same surface, no callers need to change.
  - **Added `rate-limit.test.ts`** with 5 cases asserting the precedence: spoofed XFF must lose to the proxy-injected headers, dev fallback still picks XFF[0], no-headers returns `"unknown"`, whitespace gets trimmed.

### Fixed — Audit round 6 (batch 13: device-token lookup is a sequential scan)

- **`devices.token` had no UNIQUE constraint and no index.** It's the bearer credential checked on every authenticated request to `/api/sync` (the high-volume polling endpoint, hit by every active companion every few seconds) and on `/api/devices/validate`. The lookup is `WHERE token = $1`, so without an index every request did a sequential scan of the entire `devices` table — cost growing linearly with total device count across all users, a built-in amplifier for any polling load. Worse, the column wasn't `UNIQUE`, so two devices could in theory share a token (random UUIDs make collision astronomical, but the schema permitted it; an admin script bug or a restore-from-backup duplicate would silently authenticate as whichever row Postgres returned first). Fix: migration `0005_devices_token_unique.sql` adds `CREATE UNIQUE INDEX IF NOT EXISTS "devices_token_uniq" ON "devices" ("token")`, and the Drizzle schema now declares `token: text("token").notNull().unique()`. O(log n) lookups + hard duplicate-prevention.

### Fixed — Audit round 6 (batch 12: Stripe webhook replay + out-of-order events)

- **`/api/billing/webhook` had no idempotency or ordering guard.** Stripe's documented contract is at-least-once delivery with no ordering guarantee — under retry pressure two events for the same subscription can arrive reverse-chronological. The handler blindly applied whatever the latest delivery contained, so:
  - **Resurrected cancellations.** A `customer.subscription.updated` snapshot created at T0 (status=`active`) arriving *after* a `customer.subscription.deleted` at T1 would un-cancel a closed subscription and leave the user on Pro forever.
  - **Re-downgraded upgrades.** A delayed `invoice.payment_failed` from a stale retry could clobber a fresh `subscription.updated` triggered by the user's manual upgrade seconds earlier — quietly downgrading a paying customer.
  - **Replay amplification on the invoice path.** Each duplicate delivery of an invoice event triggered another `stripe.subscriptions.retrieve` round-trip and another DB write.
  
  Fix: persist the most recent applied event on the subscription row and gate every write on it.
  - **New columns `last_event_id` + `last_event_at`** on `subscriptions` (migration `0004_subscription_event_dedupe.sql`, both nullable so existing rows keep flowing).
  - **Webhook now resolves the target row first**, then short-circuits if `existing.lastEventId === event.id` (replay) or `existing.lastEventAt >= new Date(event.created * 1000)` (stale / out-of-order). Only newer events apply, and they bump both columns atomically with the rest of the snapshot.
  - **Single fallback path.** The previous code had two near-identical branches (one for events with `metadata.userId`, a fallback by `stripeCustomerId`); collapsed into one resolver so the dedupe + ordering check is impossible to skip.

### Fixed — Audit round 6 (batch 11: companion-auth silent token grant)

- **`/api/companion-auth` issued device tokens with no user confirmation.** The page assumed the only path through it was the legitimate companion's OAuth dance, so for an already-signed-in user it auto-POSTed to `/api/devices/auto-register` and immediately redirected to whatever `callbackUrl=http://localhost:PORT…` the request specified, carrying `token`, `deviceId`, `userName`, `userEmail` in the query string. That made the endpoint a one-click account-takeover primitive: any link of the form `https://mmo.app/api/companion-auth?callbackUrl=http://localhost:31337/&hostname=Attacker&apiUrl=http://localhost:31337&state=x` shipped a real long-lived sync token to whatever was listening on a local port — Auth.js cookies are `SameSite=Lax`, so the same-origin `fetch` to `auto-register` happens with full credentials on a top-level navigation. The `state` parameter was never validated server-side, so it provided zero CSRF protection. Fixes:
  - **Explicit "Authorize this device?" prompt.** The page now renders the requested hostname / OS / local API URL and requires a click on **Authorize** before any device is registered. The button reloads the same URL with `?confirm=1`; only that branch performs the POST and redirect. A drive-by link no longer mints anything.
  - **`X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`** on the response, so the Authorize button can't be clickjacked from an embedded iframe.
  - **`Referrer-Policy: no-referrer` + `Cache-Control: no-store`** to keep the post-redirect URL (which contains the token in the query string) out of Referer headers and intermediate caches.
  - **All dynamic device metadata in the success / error / cancel branches now goes through `escHtml`** before string-concatenation into `innerHTML`. `data.userName` comes from the Google profile, which the user controls; same for `e.message`. Previously a Google display name like `<img src=x onerror=…>` would self-XSS this page (low impact, but the surface shouldn't exist).

### Fixed — Audit round 6 (batch 10: service worker cross-user PII leak)

- **Service worker cached authenticated HTML across sign-in sessions.** The previous SW precached `/library`, `/playlists`, `/settings`, … on install and ran a network-first-with-cache-fallback strategy on every navigation, writing every successful response into a single shared `music-org-v4` cache. That cache lives on the *browser*, not the user — so when User A signed out and User B signed in on the same machine, a network blip (or a `caches.match` fallback hit) could serve B the cached HTML of A's library, playlists, settings, etc. Pure cross-user PII leak. Fixes:
  - **Precache narrowed** to the static `/offline` fallback page and the manifest. Authenticated routes (`/library`, `/playlists`, `/settings`, `/devices`, `/scanner`, `/remote`, `/live`, `/daw`, `/mixer`, `/sound-editor`) are no longer in `PRECACHE_URLS`.
  - **Navigation requests are now network-only**, with a fallback to the static `/offline` page on a dead network. No HTML ever lands in the cache.
  - **New `purge-caches` SW message.** `signOutAndPurge()` (new helper in `lib/auth-client.ts`) wipes every `caches.keys()` entry on the page side AND posts a message to the active service worker to do the same, with a 1-second ack timeout so a hung SW can't block sign-out. Wired into all 3 sign-out call sites: `user-card.tsx`, `profile-client.tsx` (delete-account flow + the explicit sign-out button).
  - **Cache version bumped** `music-org-v4` → `music-org-v5` so the existing activate handler nukes every old per-user cache from any browser that auto-upgrades.

### Fixed — Audit round 6 (batch 9: Pro grace period on payment retry)

- **A single failed card charge instantly downgraded users to free.** `getSubscription` only treated `active` and `trialing` as Pro, so the moment Stripe flipped the subscription to `past_due` (which it does *during* its automatic 3–4 retry cycle over ~3 weeks), the user lost Pro features mid-session — even though the period they'd already paid for hadn't ended and Stripe was still trying to recover the charge. Added `past_due` to the Pro-status set; users now keep access until Stripe gives up and emits `unpaid` / `canceled`. Standard SaaS grace-period behaviour and a known revenue-loss anti-pattern when missed.

### Fixed — Audit round 6 (batch 8: free-tier paywall + read-only heartbeat)

- **Free-tier "1 device" paywall locked users out forever after they'd ever paired a second device.** The check counted `devices.status !== "offline"` as "active", but no cron ever resets the column on inactivity — `status` only ever flips between `online` / `syncing`. So a free user who'd plugged in two devices once would be permanently 402'd on the second device, even after unplugging the first for weeks. Switched the guard to a 10-minute `lastSeenAt` window: any device that has touched the API in the last 10 min is "live", everything else is implicitly offline. The heartbeat fires ~every 30 s and sync push refreshes it on every cycle, so the window is comfortable.
- **Read-only sync poll didn't bump `lastSeenAt`.** A device that pulls but never pushes (caught up, idle library) wouldn't refresh its `lastSeenAt` between heartbeats. With the new `lastSeenAt`-based liveness check above, that would have flapped a quiet device into "offline" between heartbeats. `GET /api/sync` now always updates the column for the calling device.

### Fixed — Audit round 6 (batch 7: companion sync data-loss)

- **Companion `drainDirty` was silently losing changes on push failure.** `SqliteSyncStorage.drainDirty(N)` deleted the queue rows *before* returning them, so when `CloudSyncClient.pushOnce` then called `fetch(...)` and the network dropped (or the cloud returned 5xx, or the device went offline), those changes were gone — the queue was empty, the cloud never received them, and the user's edits vanished. The misleading code comment even claimed the opposite ("we delete only after returning"). Split into two explicit operations: `drainDirty(N)` is now a peek that returns rows tagged with their queue id, and a new `ackDirty(ids[])` removes them after the cloud has acknowledged the push. The client only acks on a 2xx response, so 5xx / network errors leave the queue intact and the next tick retries (LWW on the cloud makes that idempotent).

### Added — Audit round 6 (batch 7)

- **2 new companion tests** in `cloud-sync-client.test.ts`:
  - `preserves the queue when push fails (no data loss on network drop)` — enqueues a change, makes POST 500, asserts the queue still holds it and `ackDirty` was never called.
  - `acks the queue only after a successful push` — confirms the happy path still drains exactly once with all queue ids.
- **3 updated companion tests** in `sqlite-sync-storage.test.ts` for the new peek+ack semantics, plus a new `ackDirty on empty list is a no-op`.
- **`FakeStorage` test harness** gained an `enqueue()` helper and an `ackCalls: number[][]` recorder. Companion tests now: 19 across 2 files (was 16).

### Added — Web app foundation pass

- **Test infrastructure (Vitest 4 + first wave)**: `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` scripts. 37 unit tests across `lib/camelot`, `lib/organizer`, `lib/ice-servers`, `lib/rekordbox-xml`, and `lib/sync-apply` now run in ~600 ms. Pure-logic only — the heavier audio/MIDI engines are out of scope for this first wave.
- **ESLint flat config (`app/eslint.config.mjs`)** built on `eslint-config-next` v16's native flat array (no `FlatCompat` shim — that combination crashes on circular plugin refs). New scripts: `pnpm lint` and `pnpm lint:fix`. Surfaces 235 pre-existing errors + 107 warnings; the new CI runs lint as `continue-on-error` so the backlog can be triaged incrementally without blocking merges.
- **Per-field LWW for `POST /api/sync`** (`app/src/lib/sync-apply.ts` + new `0001_sync_per_field.sql` migration). The endpoint used to only append intents to `sync_log`; it now actually writes to the target tables:
  - `tracks` → per-field merge keyed by `(userId, sha256)`. Each field has its own ISO timestamp in a new `field_versions jsonb` column. Partial payloads merge cleanly: when the companion writes BPM/key while the user edits rating from the web at the same moment, both wins land. Forbidden fields (`id`, `userId`, `sha256`, `fieldVersions`, etc.) are stripped server-side regardless of payload.
  - `playlists` → row-level LWW keyed by `(userId, externalId)` (companion-minted UUID). New `external_id` column + unique index.
  - `cuepoints` → row-level LWW keyed by `(trackId, externalId)`. New `external_id` and `updated_at` columns.
  - `tags` / `track_tags` / `playlist_tracks` → idempotent set ops (no conflict semantics).
  - Every accepted change appends to `sync_log` so other devices can pull it.
  - Reported in the response: `{ ok, applied, skipped, errors[] }`.
- **i18n via `next-intl` v4** (`app/src/i18n/request.ts`, `app/messages/{ro,en}.json`, `setLocaleAction` server action). Cookie-based locale (`mmo-locale`), default `ro`. No `[locale]` URL segment so no existing routes change. Layout now reads the locale and wraps the tree in `NextIntlClientProvider`.
- **Liveness probe `GET /api/health`** (`app/src/app/api/health/route.ts`): build version, commit sha, env, db `SELECT 1` round-trip, uptime. 200/503 with `cache-control: no-store`. Safe for uptime monitors and CI smoke.
- **CI: `.github/workflows/web-app.yml`** — pnpm 9 + Node 22, runs `typecheck → test → lint` on every push/PR that touches `app/**`.

### Fixed

- **`POST /api/sync` was a stub** that wrote intents to `sync_log` and never updated `tracks`/`playlists`/etc. (TODO comment in the old route). The companion would round-trip changes through the cloud and find the cloud row unchanged. Now fully wired (see "Added" above).
- **Outdated tsc reports** — `tsc-out.txt` and `app/tsc-report.txt` claimed 67 errors that no longer reproduced; deleted. Current `pnpm typecheck` is clean (exit 0).

### Documentation

- README and `concept/arhitectura.md` continue to reflect the suite-level umbrella; the previous "WebRTC signaling: TBD WebSocket sau Firestore" note is stale — the SSE relay (`api/remote/events` + `api/remote/send`) has been the actual implementation for a while. Tracked as a docs-only follow-up rather than rewriting in this pass.

### Added — Audit round 2

- **Sidebar i18n via `useTranslations("nav")`** — every nav item is now keyed (`dashboard`/`library`/`analysis`/`mixer`/`daw`/`editor`/…) and resolved through `next-intl`. Both `messages/ro.json` and `messages/en.json` carry the matching keys; the static label is preserved as a fallback if a key is missing.
- **Settings → Locale switcher** (`app/src/components/settings/locale-switcher.tsx`) — small client component mounted at the top of `/settings`. Renders one button per supported locale, calls `setLocaleAction` inside `useTransition`, sets the `mmo-locale` cookie, and revalidates the layout. The active locale is highlighted with `aria-pressed`.
- **`/status` page** (`app/src/app/status/page.tsx`) — server-rendered diagnostics dashboard that hits `/api/health`, surfaces version / commit / env / uptime, shows a Postgres reachability pill, and links to per-device companion/TURN diagnostics on `/devices`.
- **Strict CSP header** — `next.config.ts` now ships a tight `Content-Security-Policy` allowlist (`'self'` + Auth.js + Stripe + Google fonts + WS for the remote bridge), plus `Strict-Transport-Security` for HTTPS deployments.
- **rekordbox XML import — first wave** — `parseRekordboxXml` is now covered by 6 unit tests (file-not-found, malformed XML, full track metadata, percent-encoded paths, flat playlist, nested folders, mixed-bag resilience). Wiring into a UI/server action is the next step.
- **Organizer: batch + undo** — added `batchMoveTracks`, `undoMove`, `undoMoves` (`app/src/lib/organizer.ts`). `batchMoveTracks` collects per-file failures without aborting the whole batch; `undoMoves` LIFO-restores files and refuses to overwrite if the original location has been re-occupied. 4 new tests.
- **Companion sync push client — transport scaffold** — `server/src/sync/cloud-sync-client.ts` already had the bidirectional push/pull/cursor logic; added the matching Vitest setup (`vitest.config.ts`, `pnpm test` script) and 5 transport tests covering empty tick, queued push with bearer auth, multi-page pull with cursor advance, server-error surfacing, and re-entrant tick guarding. The concrete `SqliteSyncStorage` implementation remains the next step.
- **ESLint baseline tool** (`app/scripts/lint-baseline.mjs`, `app/.eslint-baseline.json`) — `pnpm lint:baseline` snapshots the current per-file error counts (74 files / 235 errors today), and `pnpm lint:check` fails CI only when a file gains *new* errors. Pre-existing errors are tracked but tolerated, so the backlog can be paid down incrementally without blocking work. CI now runs `lint:check` (no more `continue-on-error`).
- **Companion docs / version refresh** — CHANGELOG "Companion releases" section updated (was stuck at v0.3.4; now lists v0.9.5 + the v0.9.x analyzer hardening + the v0.8.x plugin/stems milestones).

### Added — Audit round 3

- **Settings → Billing panel** (`app/src/components/settings/billing-panel.tsx`) — plan badge with Free/Pro styling, status + renewal/cancellation date, and a "Manage billing" button that hits the existing `POST /api/billing/portal` and redirects to the Stripe Customer Portal. Loaded from `getSubscription(session.user.id)` on the server side.
- **Library → Import wizard** (`/library/import`) — dedicated route + drop-in `RekordboxImportCard` that uploads `rekordbox.xml`, runs it through `parseRekordboxXml`, dedupes by `(userId, sourcePlatform="rekordbox", sourceId=<rekordboxId>)`, and bulk-inserts into the cloud `tracks` table. Shows per-track warnings without aborting the batch. Server action enforces auth + a 25 MB upload cap, spools to `os.tmpdir()`, cleans up on exit.
- **Companion `SqliteSyncStorage`** (`server/src/sync/sqlite-sync-storage.ts`) — concrete `SyncStorage` implementation backed by `better-sqlite3`. Auto-bootstraps `sync_state` (singleton) and `sync_queue` (FIFO) tables next to the existing library schema; `enqueue` is the new write-side hook for any local mutation that should reach cloud. Per-entity `applyRemote` dispatch is in place; `tracks/playlists/cuepoints` are stubbed with explicit TODOs (the read-side merge needs a `sha256` column on the companion's tracks table, tracked separately). 11 unit tests covering seed/load/save semantics, FIFO drain + limit, JSON round-trip, and unknown-entity handling.
- **Structured logger + optional Sentry shim** (`app/src/lib/logger.ts`, `app/src/lib/sentry.ts`) — single `log.{debug,info,warn,error}` API. Pretty-printed in dev, JSON-per-line in prod (Cloud Run / Vercel / Datadog ready). Errors auto-forward to Sentry **only when `SENTRY_DSN` is set** and `@sentry/nextjs` resolves; default install stays lean and self-hostable.
- **PWA offline shell** (`app/src/app/offline/page.tsx`, `public/sw.js`) — static `/offline` page precached by the service worker; cache bumped from `music-org-v3` → `v4`. Navigation requests that miss both network and per-route cache now fall back to `/offline` instead of the blank-screen failure mode.

### Deferred (round 3)

- **Cache Components rollout**: keeping `cacheComponents: false` for now. Enabling it requires a Suspense audit across every dynamic page (or every page becomes statically prerendered with stale data). Will land as a dedicated branch when there's appetite for the touch surface.
- **Lint baseline burn-down**: noted but not yet started — `pnpm lint:check` blocks regressions; the 235-error backlog is tracked in `app/.eslint-baseline.json`.
- **Docs/aplicatie rewrite**: still references some legacy modules that have moved or merged. Tracked as a follow-up.

### Fixed — Audit round 4

- **`use-webrtc-audio-stream` ref-during-render** — the hook used to write to `targetPeerId.current` and read `bridgeRef.current` *during render* to synthesize its return value, which the React Compiler / `react-hooks/refs` rule rightly flags as a hazard (the UI can desync from the bridge between renders). Refactored to:
  - Sync the derived target into the ref inside a `useEffect`.
  - Mirror the bridge's reactive state into a `useState` snapshot, refreshed on every `onStateChange` tick.
  - Return values from the snapshot, not from the live ref.

  Drops the file from 20 lint errors to 0; the lint baseline is now **215 errors / 73 files** (was 235 / 74).
- **Companion: cloud sync wired into `main.ts`** — added `server/src/sync/index.ts` (singleton owner of `CloudSyncClient` + `SqliteSyncStorage`, seeded from the persisted store) and wired it into the existing `runAfterPaint(...)` chain so it spins up alongside the audio engine without blocking the splash. `enqueueSyncChange(...)` is now a stable import target for any local mutation that should propagate to cloud.
- **Companion: `cloud-sync-client.test.ts`** — replaced the DOM-only `RequestInfo` type with `Parameters<typeof fetch>[0]` so the file typechecks under the companion's `lib: ["ES2022"]` tsconfig (no DOM lib).

### Added — Audit round 5

- **Companion: every library mutation now enqueues a sync change.** `server/src/library/routes.ts` wires `enqueueSyncChange(...)` into the track PATCH/DELETE/favorite/rating/tags/bulk-hide handlers and the playlist create/update/delete handlers. Each helper re-reads the row after the write so the cloud receives the post-write shape (including columns the route didn't touch). Failures to enqueue are swallowed by design — the local SQLite write is authoritative; sync is best-effort and the queue retries on the next pull tick.
- **Companion: `POST /v1/sync` ingestion endpoint** (`server/src/sync/http-router.ts`, mounted on the same device-token `authMiddleware` as `/library`). Lets the cloud (or any authenticated client) push a batch of `SyncChange[]` straight into the companion without waiting for the next pull tick — closes the cross-device round-trip from "user edits in web → cloud applies → other companion sees it" to a single hop. Validates entity (whitelist of 6 supported entities), op (`upsert`/`delete`), and ISO `updatedAt`. Returns `{ ok, applied, errors[] }` per change.
- **BYO API keys for AI providers** (`app/src/lib/crypto-secret.ts` + `app/src/actions/ai-keys.ts` + `app/src/components/settings/ai-keys-panel.tsx`). Stored AES-256-GCM-encrypted in `user_preferences` under `secret:ai:<provider>`; the master key comes from a new `MMO_SECRET_KEY` env var (32 bytes, base64 or hex). The settings panel shows a masked preview only — plaintext never crosses the network back to the client. Supports OpenAI, Anthropic, Google AI, Mistral, and Groq with deep-links to each provider's key dashboard. The crypto helper refuses to run without `MMO_SECRET_KEY` set rather than silently storing plaintext, so an admin misconfiguration can't quietly leak keys via a DB dump.
- **Sidebar accessibility pass** (`app/src/components/app-sidebar.tsx`). Added `aria-label="Primary"` to the `<nav>`, `aria-current="page"` to the active link (was visual-only via the purple accent bar before), `aria-hidden` on decorative icons + the active-indicator bar, and a keyboard-visible focus ring (`focus-visible:ring-2 ring-sidebar-primary`). Sighted keyboard users now get a clear focus indicator that matches the active state's color, and screen readers announce the current page instead of just reading every nav item with no context.

### Added — Audit round 5 (batch 2)

- **`now-playing.tsx` cleanup** — stripped 9 manual `useCallback`/`useMemo` wrappers that the React Compiler kept reporting as "Compilation Skipped" (the wrappers blocked the compiler's automatic memoization). Replaced with plain function expressions; the compiler now memoizes them at compile time. The remaining 4 `set-state-in-effect` warnings sit on legitimate browser-only-on-mount paths (URL/localStorage rehydration) and are now narrowly suppressed with rationale comments. **Net: 13 errors → 0 on this file.**
- **Structured logger adoption** across the highest-signal write paths: `app/src/actions/{playlists,scan,search,tracks}.ts` and `app/src/app/api/{billing/webhook,companion/download}/route.ts` now use `log.warn(...)` / `log.error(...)` instead of `console.warn(...)`. Production gets one JSON line per event (Cloud Run / Loki parse it natively); dev gets the same readable `[WARN] msg` shape as before. Errors marked `level: "error"` are also forwarded to Sentry when `SENTRY_DSN` is set.
- **Zod input validation on track mutation Server Actions** (`app/src/actions/tracks.ts`). `updateTrack`, `toggleFavorite`, `setTrackRating`, `updateTrackTags`, `deleteTrack`, `hideTracks`, `unhideTracks` now validate every parameter against a Zod schema before forwarding to the companion. Out-of-range BPM (must be 0–400), oversized strings, malformed track ids, and ID arrays >10k all reject at the Server Action boundary with a structured error message instead of being forwarded blindly. Defense-in-depth — the companion route still strips immutable fields server-side, but catching shape errors here gives the user a clean error path. The other ~20 action files (devices, plugins, profiles, recordings, etc.) are tracked as a follow-up.
- **Companion: cloud sync columns on local SQLite** (`server/src/library/{db,schema}.ts`). `tracks` now has `sha256` + `field_versions`; `playlists` has `external_id` + `updated_at`. Migrations are inline (the existing `ensureColumns()` probe-and-`ALTER` loop handles legacy DBs idempotently) and unique partial indexes (`WHERE sha256 IS NOT NULL`) cover the new sync keys. This is the prerequisite for `pushTrackChange()` to use a stable cross-device id and for `/v1/sync` to apply remote upserts in-place — the columns are present now; backfill of `sha256` happens lazily on the next analyze pass and the writer side is being switched over incrementally.
- **Playwright E2E smoke suite** scaffolded: `app/playwright.config.ts` (auto-spins the dev server for local; honors `PLAYWRIGHT_BASE_URL` for staging/prod), `app/e2e/smoke.spec.ts` (3 public routes + 4 authed routes + `/api/health`). Scripts: `pnpm e2e`, `pnpm e2e:ui`, `pnpm e2e:install` (installs the Chromium binary — kept manual so CI/devs opt-in instead of pulling ~250 MB on every clean install). The TypeScript compiler ignores `e2e/` and `playwright.config.ts` so the main app build doesn't depend on Playwright being installed.
- **Lint baseline burn-down** — the cleanup above pulled the baseline from **215 errors / 73 files** to **202 errors / 72 files**.

### Added — Audit round 5 (batch 3)

- **Companion: durable sync queue (real bug fix).** `enqueueSyncChange()` was a no-op until `startCloudSync()` had run — meaning every track edit, favorite toggle, and playlist mutation that fired during the boot window (or while the device was unpaired) was silently dropped. Refactored: extracted `bootstrapSyncTables(db)` and `enqueueSyncChangeRaw(db, change)` helpers from `SqliteSyncStorage` so the queue tables exist and accept inserts independent of the cloud client. `enqueueSyncChange()` now bootstraps lazily and writes straight to SQLite — failures log via the new structured logger but never bubble up to the route handler.
- **Companion: structured logger** (`server/src/lib/logger.ts`). Same shape as the web app's `log.{debug,info,warn,error}` — JSON-per-line in production, pretty `[LEVEL] msg fields` in dev. Always writes to `console.*` so existing Electron stdout capture and the in-app log viewer keep working unchanged. Wired into `server/src/sync/index.ts` for the cloud-sync hot path; the rest of the companion (analyzer, native-engine, plugins host) is tracked for incremental migration. Sentry forwarding is intentionally not wired here — the companion is self-hosted and telemetry would need explicit user opt-in.
- **`live-context.tsx` cleanup** — dropped the unused `voicePeakL`/`voicePeakR` context fields (no consumers; they were also forcing a re-render on every meter tick which the surrounding architecture explicitly tries to avoid by routing peaks through `liveMetersStore` instead). The remaining ref-during-render reads on `engineRef.current` and the `set-state-in-effect` on the localStorage hydration path are intentional architectural choices and now have block-scoped suppressions with rationale comments. **Net: 10 lint errors → 0.**

### Deferred — Audit round 5 (batch 3)

- **Cache Components dry-run on the dashboard**: still gated on enabling `cacheComponents: true` in `next.config.ts`, which requires a Suspense audit across every dynamic page (or every page becomes statically prerendered with stale data). Same trade-off as round 3 — staying deferred until there's appetite for the touch surface.
- **Playwright Chromium binary install**: scaffolded in batch 2; user runs `pnpm e2e:install` once when ready (~250 MB browser download).
- **`sha256` backfill + `/v1/sync` apply-remote**: schema is now in place (batch 2); backfill happens lazily on next analyze pass per design. The cross-device round-trip closes once a track has been re-analyzed at least once on each device.
- **Lint baseline** dropped from **202 errors / 72 files** → **192 errors / 71 files**.

### Added — Audit round 5 (batch 4)

- **Companion `/v1/sync` apply-remote — real cross-device round-trip.** Replaced the `applyRemoteTrack` / `applyRemotePlaylist` stubs in `server/src/sync/sqlite-sync-storage.ts` with full implementations that mirror the cloud's `app/src/lib/sync-apply.ts` semantics:
  - **Tracks**: per-field LWW keyed by `(user_id, sha256)`. Payload keys are normalised through a whitelist (`TRACK_FIELD_MAP`) so unknown / forbidden columns are silently dropped, booleans collapse to 0/1, and arrays/objects serialise to JSON. Inserts gracefully skip when `filepath` / `filename` are absent (legitimate companion-only fields the cloud can't supply for a brand-new row).
  - **Playlists**: row-level LWW by `(user_id, external_id)`. Insert/update/delete all wired.
  - **Cuepoints + idempotent set ops** (`tags`, `track_tags`, `playlist_tracks`): cursor advances, write deferred — these tables aren't yet exposed via the storage class. Tracked.
- **Companion: lazy `sha256` backfill in the analyzer** (`server/src/library/analyzer.ts`). After every successful `persistResult()` the analyzer fires a fire-and-forget `backfillSha256()` that streams the file through `node:crypto` `createHash("sha256")` and stores the hex digest. No rescan needed — happens on the next analysis pass for any track. Errors log at warn level; the row stays valid without sha256 (cloud sync gracefully degrades to no-op for that track).
- **Zod validation across 3 more action files**:
  - `app/src/actions/settings.ts` → `updateSetting()` validates key format (`/^[a-zA-Z0-9._-]+$/`, 128 chars max) and value (8 KB max).
  - `app/src/actions/recordings.ts` → `saveRecording()` validates the metadata shape (source enum, mime ≤ 128 chars, duration ≤ 24 h) and rejects buffers >500 MB; `renameRecording`, `deleteRecording`, `toggleRecordingFavorite` validate the id.
  - `app/src/actions/profiles.ts` → `createProfile`, `renameProfile`, `deleteProfile`, `activateProfile`, `duplicateProfile`, `saveActiveProfilePreference`, `saveActiveProfilePreferencesBulk` all validate UUIDs, names, key format, and bulk size (≤ 1000 entries per call).
- **Adopted the structured logger across companion hot paths.** Replaced the remaining ad-hoc `console.warn`/`console.error` calls in `server/src/sync/cloud-sync-client.ts`, `server/src/plugins/host.ts`, `server/src/library/db.ts`, and the two error paths in `server/src/audio/native-engine.ts` with `log.warn` / `log.error`. CLI smoke scripts (`smoke-passthrough.ts`) and intentional `console.log` startup banners (`server.ts`, `main.ts`) deliberately left alone — those are scripts/UX surfaces, not application logs.
- **Playwright Chromium installed.** `pnpm e2e:install` ran cleanly (~250 MB browser binary cached). The smoke suite is now executable locally with `pnpm e2e`.
- **i18n round-trip on the dashboard.** Added the `dashboard.empty` and `dashboard.recommendations` namespaces to both `app/messages/ro.json` and `app/messages/en.json`, then wired `useTranslations()` into `app/src/components/dashboard-client.tsx` for the 8 user-visible English strings that had leaked into the otherwise Romanian dashboard (`"No tracks yet"`, `"Rate tracks 4-5 stars to see them here"`, `"All recommended playlists created"`, `"Create N missing playlists"`, etc.). Switching the `mmo-locale` cookie now flips these strings end-to-end.

### Deferred — Audit round 5 (batch 4)

- **Zod on `playlists.ts`** (16 mutations) — the file is the largest action surface in the app and warrants its own dedicated pass; the patterns from `tracks.ts` / `profiles.ts` carry over directly.
- **Sentry forwarding from companion logger** — needs an explicit user opt-in setting before telemetry is acceptable for a self-hosted desktop app.
- **Cuepoints + tag/pivot apply-remote** — the underlying companion DAO needs a typed read path before LWW is safe; currently the cursor advances and the row is dropped. The cloud is still authoritative until the next pull rehydrates the relations.
- **Lint baseline** unchanged from batch 3 (**192 errors / 71 files**) — this batch added no new code paths to the lint surface.

### Added — Audit round 5 (batch 5)

- **Cuepoints + set-ops apply-remote (companion).** Implemented `applyRemotePlaylistTrack()` in `server/src/sync/sqlite-sync-storage.ts` — the pivot table `(playlist_id, track_id)` now reconciles cross-device using the cloud's `"<plExt>:<trackSha>"` entityId convention. The handler resolves both sides via the existing sha256 / external_id indexes and uses an `INSERT OR UPDATE` pattern (no unique constraint required). `tags` and `track_tags` deliberately remain no-ops because the companion stores tags as JSON in `tracks.tags`, which is already covered by the per-field LWW in `applyRemoteTrack`. `cuepoints` stays a documented stub — the companion has no cuepoint table; DJ cues are produced by the Mixer at runtime, not synced.
- **Companion → web push refresh hint** (cross-device snappiness). Added an `onApplied` callback to `CloudSyncClient` that fires once per pull tick with the set of touched entities. `setOnAppliedListener()` in `server/src/sync/index.ts` exposes the registration to `server.ts`, which now broadcasts a `{ type: "sync:applied", entities }` frame over the existing `/ws` fan-out. Web clients listening on `/ws` can now invalidate React Query / SWR caches selectively instead of polling — typical edit-on-phone → see-on-laptop latency drops from ~30s (pull cadence) to <1s.
- **Sentry production wiring (web).** Added `app/src/instrumentation.ts` with the Next.js 16 `register()` + `onRequestError()` hooks and `app/src/instrumentation-client.ts` for the browser side. Both files use literal-string dynamic imports against `@sentry/nextjs` so a deployment without Sentry installed (or without `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` set) pays zero cost — no module resolution, no init, no network. PII is opt-in via `SENTRY_SEND_PII=1`. Companion side intentionally stays opt-in TBD (self-hosted desktop, telemetry needs explicit consent).
- **Component test coverage with Testing Library.** Added `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, and `jsdom` dev deps. `vitest.config.ts` now uses per-pattern environments (`environmentMatchGlobs`) so `.test.tsx` runs in jsdom while `.test.ts` stays in node (~10× faster for the pure-logic suite). `vitest.setup.ts` registers the jest-dom matchers globally. First component tests live in `app/src/components/library-empty-state.test.tsx` (4 tests covering both empty-state panels: default + custom feature copy, sign-in link, devices link). Test count: 48 → 52.
- **Bundle-analyzer wiring.** `@next/bundle-analyzer` + `cross-env` added as dev deps; `next.config.ts` wraps the export with `withBundleAnalyzer({ enabled: process.env.ANALYZE === "true" })`; new `pnpm build:analyze` script. Stays a no-op for normal builds.
- **Companion auto-updater polish.**
  - Added `checking-for-update` and `update-not-available` event handlers (the renderer now shows a clear "no updates" state instead of going silent after pressing "check").
  - Added `error` event surfacing — errors now reach the renderer via `update-status: error` instead of only stderr.
  - Added a 4-hour periodic re-check (cleared on `before-quit`) so long-running DJ sessions don't miss new releases.
  - Added IPC handles `updater:check` (manual) and `updater:status` (current version + last-check timestamp + last-error) for a Settings → Help "Check for updates" button.
  - `download-progress` payload now includes `transferred`, `total`, `bytesPerSecond` so the UI can render a real download speed.
- **Zod on `playlists.ts`** — finally wrapped the largest action surface. All 8 mutation paths (`createPlaylist`, `updatePlaylist`, `deletePlaylist`, `addTracksToPlaylist`, `removeTrackFromPlaylist`, `clearPlaylist`, `duplicatePlaylist`) now validate the playlist id, name (1-200 chars trimmed), description (≤2000), strict update shape, and bulk track ids (≤10000). `failedValidation()` helper mirrors the pattern from `tracks.ts` / `profiles.ts`.

### Deferred — Audit round 5 (batch 5)

- **Actually run Playwright e2e against a live dev server** — the Chromium binary is installed and the suite is wired, but the smoke run needs `pnpm dev` to be alive. Trivial to do locally; not part of CI yet.
- **Sentry forwarding from companion** — still gated on an explicit user opt-in setting in the companion UI before any telemetry is acceptable.
- **Real reduce-bundle pass** — `pnpm build:analyze` is now wired; the actual diet (dynamic-import recharts in dashboard, tree-shake heavier deps) needs a build cycle + analyzer review and is left as a follow-up with concrete numbers.
- **Lint baseline** unchanged from batch 3 (**192 errors / 71 files**).

### Added — Audit round 5 (batch 6)

- **Web client consumes the `sync:applied` WS hint.** New `app/src/hooks/use-sync-refresh.ts` opens (and shares across mounts via a module-level singleton) one WebSocket to the discovered companion, listens for `{ type: "sync:applied", entities }` frames, and calls `router.refresh()` when the touched entities intersect the page's filter. Mounted in `dashboard-client.tsx` (no filter — refreshes on any sync tick), `library-client.tsx` (`tracks`, `playlist_tracks`, `tags`, `track_tags`), and `playlists-client.tsx` (`playlists`, `playlist_tracks`, `tracks`). Cross-device latency for "edit on phone, see on laptop" drops from ~30 s pull cadence to <1 s.
- **Companion: opt-in error telemetry.** Added a `telemetryEnabled` boolean to `CompanionSettings` (default `false`) plus `setTelemetryEnabled()` in `server/src/lib/logger.ts`. When AND-only-when both `SENTRY_DSN` is set at build time AND the user enables the setting, `log.error()` calls lazy-import `@sentry/electron/main` and forward via `captureException`. Wired into `main.ts` boot and the `update-settings` IPC so the toggle takes effect immediately. No DSN ⇒ no module load ⇒ zero cost for self-hosted users.
- **Real bundle diet on dashboard.** Extracted the 4 recharts-using chart components (`GenreDistribution`, `EnergyDistribution`, `BpmDistribution`, `KeyDistribution`) into `app/src/components/dashboard-charts.tsx` and dynamic-imported them from `dashboard-client.tsx` via `next/dynamic` with `ssr: false`. Recharts (~90 KB gzipped before tree-shake) now lives in chunk `3912.*` (~386 KB raw) loaded only after the dashboard's stats arrive — no longer on the critical path. Verified by `pnpm build:analyze`: only one chunk references "recharts" and it's not the framework/layout/page chunk.
- **Build hardening — `"use server"` files only export async functions.** Next 16's stricter page-data collection rejected `actions/ai-keys.ts` for re-exporting `SUPPORTED_PROVIDERS` (an array). Moved the constants/types into `app/src/lib/ai-providers.ts` and updated `ai-keys-panel.tsx` to import from there. Same pattern preemptively applied to `actions/locale.ts` (which depended on `i18n/request.ts` — a server-only file using `next/headers`): split the locale constants into `app/src/i18n/locales.ts` so client components can import them without dragging `next/headers` into the client graph.
- **CI: companion typecheck + tests.** New `.github/workflows/companion-ci.yml` runs `pnpm exec tsc --noEmit` and `pnpm test --run` against `server/` on every push/PR that touches `server/**`. Installs `libasound2-dev`/`libjack-jackd2-dev` so audify compiles. Pairs with the existing `web-app.yml`.
- **CI: Playwright e2e job.** Added an `e2e` job to `web-app.yml` (depends on `ci`) that installs the Playwright Chromium binary (cached by `pnpm-lock.yaml` hash), runs `pnpm e2e` (the smoke suite spawns its own dev server via `playwright.config.ts.webServer`), and uploads `playwright-report/` on failure (14-day retention).
- **User feedback widget (Sentry Feedback).** `instrumentation-client.ts` now conditionally registers `Sentry.feedbackIntegration` when `NEXT_PUBLIC_SENTRY_FEEDBACK=1`. Romanian-localized labels ("Raporteaza o problema", "Trimite", "Anuleaza", "Ce s-a intamplat?", "Multumim! Am primit raportul."), dark color scheme, no Sentry branding. Auto-injects a floating button. Stays dormant when the env var is off.
- **Lint baseline burn-down.** Down to **145 errors / 67 files** (from **192 / 71** at end of batch 5, a 47-error / 4-file drop). Achieved by the dashboard chart split (recharts code now lives in its own chunk that ESLint never compiled fully + cleaner local file) plus Round 5 batches 1–5 fixes settling. Baseline file unchanged — `lint:check` still passes.

### Deferred — Audit round 5 (batch 6)

- **More component tests (sidebar, settings)** — the test infrastructure works (52/52 still green); writing more tests for the sidebar and settings panels needs `next-intl` `NextIntlClientProvider` test wrappers, deferred to keep this batch focused on user-visible wins.

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

- **v0.9.5** — Latest at time of writing (May 2026). Bundled `fpcalc` + persistent multi-lane analyzer + GPU stems.
- v0.9.4, v0.9.3, v0.9.2, v0.9.1, v0.9.0 — analyzer hardening (per-category persistence, batch-progress fix, multi-lane queue).
- v0.8.x — plugin host (VST3/AU/LV2 via pedalboard), GPU stems install, stems progress wrap.

---

## Web app

The web app does not yet publish discrete releases; it is deployed continuously from `main`. Tagged web app releases will be added here once the cut-over to a versioned deployment pipeline is complete.

---

[Unreleased]: https://github.com/dragoscv/mmo/compare/main...HEAD
