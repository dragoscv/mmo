# Changelog

All notable changes to **MMO — Multi Media Organizer** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Web app and companion are versioned independently:
> - **Web app** (`app/`): see [`app/package.json`](app/package.json) — currently `0.2.0`
> - **MMO Companion** (`server/`): see [`server/package.json`](server/package.json) — currently `0.9.5`, releases at [github.com/dragoscv/mmo/releases](https://github.com/dragoscv/mmo/releases)

---

## [Unreleased]

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
