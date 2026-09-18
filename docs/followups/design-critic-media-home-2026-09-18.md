# Design critic — Media Home (2026-09-18, WP14-01)

Scored against the `design-critic` rubric (/60) using `.copilot-tmp/shots/{home-390,home-1440,
home-3440,home-media-550,tv-android-home,tv-android-title,tv-tizen-home,tv-tizen-title}.png`
(no `home-auth-*` captures existed) plus a code read of `apps/web/src/components/media/
{hero-billboard,media-row,provider-offers}.tsx` and `apps/web/src/app/media/media-home.css`.
Media Home is a **product surface with a cinematic hero**, so the hero is scored on the
artist-designer bar and rows/title page on the `frontend-design` bar.

USER ASKED FOR: "`/` becomes Media Home (Watch + Listen rows), aggregated across all paired MMO
Servers, with a hero, provider deep links, shared progress and the same JSON on both TVs."

| Surface | Craft /25 | Game feel /25 | Discipline /10 | Total | Verdict |
|---|---|---|---|---|---|
| Web `/` Media Home (390 / 1440 / 3440) | 20 | 15 → **17** | 10 | 45 → **47** | Polish pass (Rx1–2 applied) |
| Web `/media/movie/550` title page | 19 | 13 | 10 | **42** | Polish pass |
| TV Android Home + Title | 18 | 14 | 9 | **41** | Polish pass |
| TV Tizen Home + Title | 17 | 13 | 9 | **39** | Polish pass |

## Scores — web `/` (after Rx1–2)

- Craft: subject presence 4 (the billboard owns the fold; logo treatment when TMDB has one) ·
  composition 4 (content bottom-left, scrim to the left and bottom, hero clamps at 1600 px so 3440
  keeps a framed billboard instead of a stretched banner) · three layers 4 (backdrop → scrim →
  UI; rows are flat by design) · palette 4 (every value is a token; `artwork` accent drives
  `--accent-h`) · typography 4 (heading font 800/−0.02em vs. 0.85 rem meta; the row title at
  1.1 rem is one step too small against a 3 rem hero).
- Game feel: entrance 2 → **4** (was: one cross-fade; now logo → meta → overview → actions rise in
  at 0/80/160/240 ms) · tactile 3 (PosterCard lifts 1.06, chips/offers hover; hero buttons are the
  stock `Button`) · living background 1 → **3** (was a static backdrop; now a 24 s Ken Burns drift
  under `data-motion="full"`) · route morphing 3 (`<ViewTransition>` cross-fade only, no shared
  poster element) · subject artistry 3 (real TMDB art, no material treatment beyond the scrim).
- Discipline: server-first 5 (`page.tsx` RSC, `HeroBillboard`/`MediaRow` are the only client
  islands; `ProviderOffers` is a server component) · a11y + reduced motion 5 (`aria-roledescription
  ="carousel"`, dots are `role=tab`, rows `role=list` + keyboard paging, `sr-only` h1 behind the
  logo, all decorative motion is `data-motion="full"` only).

## Prescriptions (priority order)

1. **APPLIED** — Living background: `media-home.css` `@keyframes media-hero-drift` (scale 1→1.06,
   24 s, `--ease-in-out`, alternate) on `.media-hero-bg`, only under `:root[data-motion="full"]`.
2. **APPLIED** — Choreographed entrance: `.media-hero-content > *` rise in (`--dur-slow`,
   `--ease-out`) with 80 ms stagger per child. Both verified with `tsc --noEmit` (exit 0) and the
   hex gate (0 hits); no TSX change.
3. Not applied (> 15 lines) — **Shared-element morph**: give the hero backdrop and the title-page
   `.media-title-hero .media-hero-bg` the same `view-transition-name` (`media-${kind}-${tmdbId}`)
   so `/` → `/media/[kind]/[id]` morphs instead of cross-fading (needs the name plumbed through
   `MediaCard`/`PosterCard` too).
4. Not applied — **Row hierarchy**: `.media-row-title` 1.1 rem → `clamp(1.15rem, 1.4vw, 1.5rem)`
   and `.media-row-reason` into the heading line on ≥ 48 rem; the rows currently read as a list of
   equal captions under a 3 rem hero. Cheap but a visual decision for the owner.
5. Not applied — **TV hero parity**: Tizen home hero has no scrim gradient to the left, so white
   text sits on bright backdrops (`tv-tizen-home.png`); Android's hero is dimmer than the web
   scrim. Port the two-direction scrim from `media-home.css` into `apps/tv-tizen/src/styles.css`
   and `MediaRows.kt` (`Brush.verticalGradient` + horizontal) — TV-side edits, outside this item.
6. Not applied — **Title page offers**: `.media-offer` cards are equal grey tiles; the preferred
   offer should carry an accent border (`data-preferred` → `border-color: var(--primary)`) so the
   badge is not the only cue. 3 lines, but the visual weighting of "preferred" is a product call.

## Regressions vs. previous version

- None observed. `/dashboard` keeps the old music dashboard intact; `/watch/*` pages unchanged
  apart from the i18n sweep. Bundle budget: 72 routes measured, all within budget; `/` grew by the
  embla carousel + hero (see tracker §6).

## User-intent gap

Met. Hero + Watch rows merged across servers with chips, Listen rows, unified title page with
"Play on <server>" or provider deep links, TVs on the same `/media/*` JSON, progress shared
through the server. Gap is polish (Rx3–6), not structure.
