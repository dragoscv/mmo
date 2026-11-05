# WP16 design-critic review: web `/media` (WP16-43)

Date: 2026-11-05. Rubric: the `design-critic` skill (12 criteria, 5 points each, 60 total). The WP16 target is 52 or
more. TV Android and Tizen reached 52 after their fixes (`docs/design-critic/wp16-tv.md`).
The brief is tracker decision **D25**: cinematic and backdrop-first (Apple TV / Infuse), a full-bleed backdrop that
follows focus, a logo treatment, a glass OSD, and your own library before recommendations. **D31** adds: one `/media`
surface for search, browse, season/episode, profile gate, now playing and live TV, restyled with tokens.

**Result: before 37/60 (bottom of "polish pass"), after 51/60 ("ship it" band, 1 short of the 52 target).** The "after" score and the cloud e2e rerun are in the "After"
section; after-scores for motion criteria are code-based (**C**) because screenshots cannot show motion.

## Evidence

| | |
|---|---|
| Screenshots | Cloud e2e run `2611051121-d0jm` (web 3.0.3 build on a GCE VM, signed in against prod, local companion through a quick tunnel): 78 PNGs in `.copilot-tmp/e2e-wp16/shots/` (13 routes × light/dark × 390/1440/3440). Axe wcag22aa: 0 violations on all 13 routes. Home cached first paint 17–28 ms |
| Viewed | 6 shots downscaled to ≤ 640 px (`.copilot-tmp/e2e-wp16/shrink.ps1` → `small/`): Home dark 1440, Home dark 390, Home light 1440, Movies 3440 dark, Music 1440 dark, Live guide 1440 dark |
| Data limits | The companion has no TMDB key (no logos, no trailers, Home has `continue` + one hero) and no music library or Live TV source, so Music and Live TV show only their empty states. The Movies grid is 50 of 53 files without `tmdbId` → name-only placeholders |
| Code read | `components/mmo/{home-screen,hero,backdrop,title-card,row,media-shell,profile-gate}.tsx`, `browse/{title-screen,common,library-screen}.tsx`, `music/now-playing.tsx`, `app/media/{layout.tsx,mx.css,media-home.css}`, `browse.css`, `music.css`, `live.css`, `player.css`, `app/template.tsx`, `app/view-transitions.css`, `packages/ui/src/{styles.css,components/app-shell.tsx}`, `app/layout.tsx` |
| Live CSS probe | `.copilot-tmp/e2e-wp16/font-cascade.mjs`: walks the stylesheets the live Cloud Run revision serves and prints every `--font-heading` declaration with its `@layer` and selector |

Each criterion is labelled **E** (scored from screenshots), **C** (scored from code), or **E+C**.

### Two root causes found while scoring

1. **The backdrop never showed.** `.mx-backdrop` (and the hero trailer, and the Now Playing blurred cover `.np-bg`)
   were `position: fixed; z-index: -1` with no stacking context of their own. They therefore painted in the root
   stacking context *below* AppShell's opaque `bg-background` (`packages/ui/src/components/app-shell.tsx:66`). On
   every shot the Home hero is plain title text over a flat background, although the hero item has a backdrop (its
   still loads in the Continue card). So D25's central idea, "backdrop follows focus", was implemented but invisible
   on every route.
2. **The heading face was never applied.** Space Grotesk is self-hosted (`app/layout.tsx`, `localFont`), but
   next/font names the family after the JS identifier (`spaceGrotesk`) and sets `--font-heading` on `<html>`.
   `/globals.css` is linked after the next/font chunk and sets `:root { --font-heading: "Space Grotesk", "Inter", … }`.
   It has the same specificity and comes later, so it wins. The family `"Space Grotesk"` does not exist, and every
   heading fell back to Inter. The probe showed both declarations live (`#0 … @font-face font-family:spaceGrotesk`
   and `#2 /globals.css (unlayered) :root --font-heading:"Space Grotesk"…`). JetBrains Mono is broken the same way.

---

## Before (web 3.0.3, shots `2611051121-d0jm`)

```
DESIGN REVIEW — web /media (Next 16, 390 → 3440 px, light + dark)
USER ASKED FOR: "cinematic backdrop-first (Apple TV / Infuse): full-bleed backdrop follows focus, logo treatment, glass OSD; own library before recommendations" (D25) + one unified /media surface (D31)

SCORES
  Craft (25):     16/25
    1. Subject presence   2/5  E+C — hero = text title + 2 buttons on a flat background (Home 1440/390, light + dark); the backdrop layer exists (backdrop.tsx) but paints under AppShell
    2. Composition        4/5  E   — left-weighted hero with generous negative space, fluid 390 → 3440 (content clamps at 2400 px, rows full width); the 3440 Movies grid is a wall of identical grey tiles
    3. Three layers       2/5  E+C — without the backdrop there are only two layers (flat page + UI); the glass top bar is the only depth cue
    4. Palette discipline 5/5  E+C — tokens only (hex-gate 0), one violet primary + neutrals, light primary darkened in-shell for AA (mx.css:85); semantic roles clear in both modes
    5. Typography         3/5  E+C — sized hierarchy (hero clamp 2–4.25 rem / 800, row titles 700, muted meta), but one family everywhere: --font-heading resolves to Inter (root cause 2)
  Game feel (25): 11/25
    6. Choreographed entrance 1/5  C   — Home appears at once; no staged first paint (media-home.css has a 3-act rise for the OLD /watch hero only)
    7. Tactile interactions   3/5  C   — cards scale 1.05, gate tiles scale, nav pills colour-shift; no glow/ring on cards, buttons only translate 1 px
    8. Living background      2/5  C   — 600 ms crossfade + muted trailer after 3 s are coded but invisible (root cause 1); nothing moves between focus changes
    9. Route morphing         3/5  C   — global <ViewTransition default="mixai-page"> (template.tsx) gives a fade + 8 px slide on every navigation; no shared poster → title morph on /media
    10. Subject artistry      2/5  E   — no logos/trailers in this data, placeholders are muted text on a grey tile (mx.css:291), Music/Live empty states are a centred card
  Discipline (10): 10/10
    11. Server-first shell    5/5  C+E — server layout resolves auth + connections once, every page.tsx is a Server Component delegating to one client screen (the MMO Server is reached from the browser); cache-first Home 17–28 ms; hls.js lazy-loaded
    12. A11y + reduced motion 5/5  E+C — axe wcag22aa 0 on 13 routes × 6 modes, roving-tabindex nav/rows/grid, `/` shortcut, aria-busy skeletons; `data-motion="reduced"` zeroes transitions and animations in the shell, trailer blocked under reduced motion / Save-Data
TOTAL: 37/60

VERDICT
  ☐ Ship it (≥48)
  ☑ Polish pass needed (36–47)
  ☐ Redesign required (<36)
```

Sum: 2 + 4 + 2 + 5 + 3 = 16, 1 + 3 + 2 + 3 + 2 = 11, 5 + 5 = 10 → **37/60**, the bottom of
"polish pass".

**What works:** discipline. It is the most accessible surface in the project (0 axe findings in 78 renders), the
cache-first Home is an order of magnitude faster than the TVs, the palette is clean in light and dark, and the
layout holds from 390 px (bottom tab bar, icon-only nav) to 3440 px.

### Issues, ranked

No P0. Every route rendered without errors (e2e `pageerror` = 0). The gap is craft and motion.

#### P1

| # | Screen | Issue | Fix |
|---|---|---|---|
| 1 | all `/media` | **The backdrop, hero trailer and Now Playing cover backdrop are invisible**: `position:fixed; z-index:-1` paints under AppShell's `bg-background` | `mx.css:5` `.mx-shell { isolation: isolate }`; `mx.css:179` `.mx-backdrop` → `position:absolute` + inner sticky `.mx-backdrop-stage` (100dvh). With `fixed` inside an isolated shell, the layer would cover the sidebar. Move the trailer `<iframe>` from `hero.tsx:66` into the stage (`useBackdrop().trailer(key)`) so it shares the layer |
| 2 | all | **The heading face is never used** (root cause 2); also breaks `font-mono` | `app/layout.tsx:157` move `inter.variable spaceGrotesk.variable jetbrainsMono.variable` from `<html>` to `<body>`, so the inherited values beat the tokens' `:root` declarations. Use `var(--font-heading)` on `.mx-hero-title`, `.mx-row-title`, `.mx-page-title`, `.mx-card-fallback` |
| 3 | Home | **No 3-act entrance** | `mx.css`: backdrop fades in (existing 600 ms), then `.mx-hero > *` rises (420 ms, +120…340 ms), then `.mx-rows > *` stagger (+420…630 ms). transform/opacity only, full motion only. This mirrors the TVs (680 ms) |
| 4 | Home / browse | **Living background**: still between focus moves | Ken Burns `scale 1 → 1.06` / 36 s alternate on `.mx-backdrop-img[data-on]`, starting after 1.2 s, under `:root[data-motion="full"]`. Turned off by the existing reduced-motion block and `prefers-reduced-motion` |

#### P2

| # | Screen | Issue | Fix |
|---|---|---|---|
| 5 | grids / rows | Placeholder art is muted text on grey (3440 Movies) | `.mx-card-fallback`: accent radial + card gradient, title bottom-left in the heading face. `LibCard` (`browse/common.tsx:111`) shows the server still (`/video/thumbs/:id/still.jpg`, the same one the TVs use) under a scrim when there is no poster |
| 6 | cards → title | No shared-element morph on `/media` | `title-card.tsx`: on click, give only that card's poster `view-transition-name: mx-poster`. The title page poster carries the same name (`title-screen.tsx:114`). Next's navigation `startViewTransition` morphs it. Off under reduced motion |
| 7 | cards | Tactility: scale only | Card hover/focus: 2 px primary ring + accent glow shadow on `.mx-card-img` |
| 8 | Music / Live empty | A centred card on a flat page | Out of scope here (data). Reuse the backdrop with the last-played cover when music exists. `.np-bg` (now-playing) is already inside `.np { isolation:isolate }`, so it is visible there |
| 9 | Player OSD | Not in the screenshot matrix (the player needs a playing file) | The `player.css` OSD uses `--mxp-glass` panels. Score unchanged; cover it in the next e2e (`/media/play/...` with the River file) |

### User-intent gap (before)

**Partial.** D31 is met: one surface, every section, tokens, and accessible. D25 is not visible: the backdrop-first
look was built but never reached the screen, and the heading face that makes logo-less titles look designed was
silently missing.

---

## After (web 3.1.6)

Implemented: P1 #1–#4 and P2 #5–#7. Files changed:

- `app/media/mx.css`: shell isolation, absolute backdrop + sticky stage, stronger left scrim for text over images,
  Ken Burns, 3-act entrance, heading face on hero/row/page titles, placeholder art + still scrim, card ring/glow,
  `mx-poster` view-transition group, reduced-motion overrides
- `components/mmo/backdrop.tsx`: stage wrapper, `trailer(key)` API, trailer iframe in the stage
- `components/mmo/hero.tsx`: trailer through the backdrop (cleared on unmount / hero change)
- `components/mmo/title-card.tsx`: `POSTER_VT`, `tagPosterForMorph` (unique name on the clicked poster)
- `components/mmo/browse/title-screen.tsx`: title poster + skeleton carry `mx-poster`
- `components/mmo/browse/common.tsx`: `LibCard` still-frame placeholder, morph tag
- `components/mmo/player/model.ts`: `stillUrl()`
- `app/layout.tsx`: next/font variables on `<body>` (fixes headings and mono app-wide; owner chose the global fix)

Local verification (`.copilot-tmp/e2e-wp16/critic-verify.log`): `tsc --noEmit --incremental false` 0 errors,
i18n parity OK (1994 = 1994 keys), hex-gate 0 (94 files), eslint 0 errors on touched files (1 old warning
`no-sync-scripts` on prehydrate), vitest `src/components/mmo` + `src/app/media` 103/103.

### Cloud e2e rerun (working tree with the fixes)

Run `2611052100-7fev` (`pnpm e2e:cloud --target vm-prod --companion-tunnel --prod-session --out
.copilot-tmp/e2e-wp16/out-critic e2e/media-wp16.spec.ts --project=chromium --workers=2`): **10/10 passed in 2.1 min**,
`__AXE__` wcag22aa **0 violations on all 13 routes**, no uncaught page errors in any of the 6 mode × width runs,
no horizontal overflow, Home cached first paint 16–24 ms (before 17–28 ms). 220 s, about $0.011. After the run: VM
deleted (not listed), `deleted sessions: 1`, cloudflared stopped. 78 new screenshots are in
`.copilot-tmp/e2e-wp16/out-critic/test-results/media-wp16/`.

Backdrop proof without more image views (`.copilot-tmp/e2e-wp16/pixstats.ps1`). It samples the right half of the
viewport between 8 % and 45 % height, where the backdrop shows through the left scrim. The table gives 16-level
colour buckets and luma standard deviation:

| Shot | Before | After |
|---|---|---|
| Home dark 3440 | 1 bucket, sd 0.0 (flat page) | 17 buckets, sd 11.4 |
| Home dark 1440 | 11 buckets, mean luma 8.8 | 26 buckets, mean luma 19.8 |
| Home light 1440 | 12 buckets, mean luma 246 (white page) | 40 buckets, mean luma 196 |

At 390 px and on the Movies grid the region is dominated by cards in both runs, so those numbers do not discriminate.

### Score after fixes

```
DESIGN REVIEW — web /media 3.1.6
SCORES
  Craft (25):     22/25
    1. Subject presence   4/5  E+C — full-bleed backdrop now behind the hero on every width (pixel stats above), title in Space Grotesk; a TMDB logo replaces the title when the server has one (hero.tsx). 5 needs that logo on screen: the test companion runs without a TMDB key
    2. Composition        4/5  E   — unchanged layout; placeholders are now designed tiles (accent gradient + title, or the server still) instead of grey text
    3. Three layers       4/5  E+C — backdrop (+ Ken Burns) / two-stop scrim / glass top bar + UI
    4. Palette discipline 5/5  E+C — tokens only (hex-gate 0), ring/glow from --primary
    5. Typography         5/5  E+C — Space Grotesk on h1–h4 + hero/row/page titles + placeholders, Inter body, sharper scale (hero 2.25–4.75 rem / 700 / −0.035em); cloud Chromium: computed `.mx-row-title` family `spaceGrotesk`, `document.fonts.check` true (run 2611052111-bk09)
  Game feel (25): 19/25
    6. Choreographed entrance 4/5  C — backdrop 600 ms → hero children +120/200/270/340 ms → rows +420…630 ms (~1.1 s), transform/opacity, full motion only
    7. Tactile interactions   4/5  C — card scale + 2 px primary ring + accent glow (hover and keyboard focus), gate tiles, nav pills
    8. Living background      4/5  C+E — visible focus-following crossfade + Ken Burns 36 s + muted trailer after 3 s at rest (when the server has a trailer)
    9. Route morphing         4/5  C — page fade/slide (template.tsx) + shared poster → title morph (`mx-poster`, unique name per click)
    10. Subject artistry      3/5  E+C — better placeholders; still no logo/trailer in the test data and Music/Live empty states unchanged
  Discipline (10): 10/10
    11. Server-first shell    5/5  C+E — unchanged; cached Home 16–24 ms
    12. A11y + reduced motion 5/5  E+C — axe 0 × 13 routes after the change; entrance, Ken Burns, poster morph and trailer off under data-motion="reduced" and prefers-reduced-motion
TOTAL: 51/60

VERDICT
  ☑ Ship it (≥48) — 1 below the WP16 target of 52
```

**37 → 51.** The remaining point is not a code gap on `/media`. It is data:

- **Subject presence 5 and artistry 4** need the hero's TMDB logo and trailer on screen. The local companion behind
  the e2e tunnel runs without `TMDB_API_KEY` (`/media/title` returns no `logoPath`/`videos`). Restarting it with the
  key would interrupt the TV and phone agents that use the same companion, so I did not do it.

In an environment with TMDB data, scoring the same build should give 52 or 53. That is expected, not verified.

### Second cloud run: design probe added to the spec

`e2e/media-wp16.spec.ts` has a new test, "design: headings render in the heading face; the Home backdrop is on
screen". It fails if `.mx-row-title` does not compute to a Grotesk family, if the face is not loaded, or if
`.mx-shell` is not isolated (the regression that hid the backdrop). Run `2611052111-bk09`: **11/11 passed (2.0 min)**,
axe 0 on 13 routes, `__DESIGN__ {"family":"spaceGrotesk, \"spaceGrotesk Fallback\", …","loaded":true,
"backdrop":true,"isolated":true}`. Home cached paint 13–17 ms. VM deleted, `deleted sessions: 1`.

### Live

Commit `dedd76c7` deployed with `deploy-clean.ps1` (clean worktree) and `apps/web/scripts/deploy-cloud-run.ps1`.
Revision **`mixai-web-00009-qrb`** serves 100 % of traffic, and `/api/health` reports `3.1.6` with commitSha
`dedd76c7…`. An authenticated `GET /media?critic-452afa6e5f` with a minted 2 h session (deleted right after:
`deleted sessions: 1`) returned 200. Its Cloud Run log line names revision `mixai-web-00009-qrb`. The page's CSS
chunk contains `mx-backdrop-stage` and `isolation:isolate`, and `<body>` carries the next/font variable classes
(`<html class="font-sans">`). There were 0 responses with status 5xx in the 20 minutes after the deploy.

### User-intent gap (after)

**Mostly met.** The D25 backdrop-first look is now actually on screen on every `/media` route, in light and dark, at
390, 1440 and 3440 px, with entrance and ambient motion matching the TVs. D31 is unchanged and met. The glass OSD
and logo treatment exist in code but were outside this screenshot matrix and data.
