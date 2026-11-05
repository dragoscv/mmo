# WP16 design-critic review: TV Android and Tizen (WP16-29, WP16-35)

Date: 2026-11-05. Rubric: the `design-critic` skill (12 criteria, 5 points each, 60 total). The WP16 target is 52 or more.
The brief is tracker decision D25 plus the WP16 design language in `docs/mixai-design-tracker.md`: cinematic and backdrop-first in the style of Apple TV and Infuse, with a full-bleed backdrop that follows focus, a logo treatment, a glass OSD, and your own library before recommendations.

**Result: TV Android 44/60, Tizen 44/60. Both need a polish pass (36–47). Neither meets the ≥ 52 target yet.**

## How the evidence was gathered

| | TV Android | Tizen |
|---|---|---|
| Device | Chromecast with Google TV `192.168.100.31:38193`, app `ro.mixai.tv` (debug build already installed) | Odyssey G8 `192.168.100.135`, app `mXa1TvApp0`, inspector over CDP (`sdb debug`, forwarded to 9333) |
| Method | `adb screencap` plus `uiautomator dump` text, D-pad keyevents. `topResumedActivity` is asserted before every key batch; one batch was aborted because the launcher was on top. Mutex `Global\mixai-tv-device` | CDP `Page.captureScreenshot` at 2580×1080, `Input.dispatchKeyEvent` for D-pad, `Runtime.evaluate` for text and focus keys. Mutex `Global\mixai-tizen-device` |
| Screens captured | profile picker, Home (hero + rows + rail), Movies grid, TV shows grid, Title (movie, plus show with seasons and episodes), Search with results, Player OSD (uiautomator text and OSD overlay; the video plane is black), Music, Live TV, Settings | profile picker, Home (hero + rows + rail), Movies grid, TV shows grid, Title (movie), Search, Player OSD (an unmatched show opened straight into the player), Music, Live TV, Settings |
| Not exercisable (data) | Music and Live TV: the server has no music library and no channel source, so only the empty states could be scored. Server has 6 movies and 1 show | Same for Music and Live TV. Server `.61` has 50 of 53 movies with `tmdbId: null`, so the library grid is mostly placeholders |
| Scripts | `.copilot-tmp/critic/atv.ps1` (steps `wake/start/keys/shot/ui/clearperf`) | `.copilot-tmp/critic/tz-steps.json`, `tz-steps2.json` via `.copilot-tmp/wpm/device.ps1` |

**Device-state note (Android):** the Chromecast still had `debug.mixai.perf=noscrim` set by an earlier perf A/B run. That setting removes the backdrop scrims, so shots `atv-01…11` show no scrims. I cleared it with `setprop debug.mixai.perf ''`, which restores the default where every effect is on. Shots `atv-21…33` show the real shipping look, and the scoring uses those.

A shot ending in `-640.jpg` or `.jpg` is a 640-px copy. All screenshots stay in `.copilot-tmp/critic/` and are not committed.

Criterion 11 ("server-first shell") is written for web. For the TV apps it is read as the architecture of the shell and data layer: cache-first paint, keep-alive or saveable stack, virtualisation, restoring focus on Back, and measured frame time.

Each criterion below is labelled **E** (scored from device evidence), **C** (scored from code) or **E+C**.

---

## TV Android (2.0.0, `apps/tv-android`)

```
DESIGN REVIEW — TV Android (Chromecast 4K, 1920×1080 app buffer)
USER ASKED FOR: "cinematic backdrop-first (Apple TV / Infuse): full-bleed backdrop follows focus, logo treatment, glass OSD; own library before recommendations" (D25)

SCORES
  Craft (25):     20/25
    1. Subject presence   5/5  E   — full-bleed TMDB backdrop + title logo (atv-21-home, atv-02-rows): unmistakable
    2. Composition        4/5  E   — left-weighted hero, generous right negative space; title page clips its own logo on open (atv-23-title-movie), primary CTA = "Back" on a title without a local file
    3. Three layers       4/5  E   — backdrop / partial scrims / UI clearly separated once scrims are on (atv-22-rows); show page backdrop very busy behind episode stills
    4. Palette discipline 4/5  E+C — tokens only (hex-gate 0), violet primary/ring + neutrals; profile avatar magenta gradient adds a 3rd accent
    5. Typography         3/5  E+C — sculpted TvType scale (3.5×→0.69×, weights 400–700) but one system family; no heading face; logo-less titles fall back to plain headline text ("River", atv-10-movie)
  Game feel (25): 16/25
    6. Choreographed entrance 2/5  C   — Home = one AnimatedContent fade 220 ms (HomeScreen.kt:210); no atmosphere → subject → UI sequence
    7. Tactile interactions   4/5  E   — focused card scale + ring + accent glow, buttons scale, rail expands with labels (atv-04-rail), keyboard key highlight (atv-32-search)
    8. Living background      3/5  E+C — backdrop crossfades 300 ms and follows focus (150 ms debounce); between moves it is a still image
    9. Route morphing         4/5  C+E — SharedTransitionLayout poster→title (Nav.kt:198, sharedPoster), fade+scale 220 ms nav; Back restored focus to the same card (atv-10c-back, atv-23b-back-restore)
    10. Subject artistry      3/5  E   — logo treatment + honest chips (17+, HD, ★); placeholder card is a flat accent gradient with text (atv-05-library "River")
  Discipline (10): 8/10
    11. Shell (TV-adapted)    5/5  E+C — SWR disk cache, SaveableStateHolder stack, focus restore verified on device; benchmark Home 0.80 s, D-pad p50 38 ms (WP16-18/20)
    12. A11y + reduced motion 3/5  C+E — contentDescription on posters, decorative icons null, D-pad order sane; NO in-app reduced-motion handling (rg "reduc|ANIMATOR" = 0 hits; only the system animator scale applies)
TOTAL: 44/60

VERDICT
  ☐ Ship it (≥48)
  ☑ Polish pass needed (36–47)
  ☐ Redesign required (<36)
```

**What works:** the Home hero is genuinely cinematic. It has the logo, chips and backdrop, and the hero follows the focused card (`atv-02-rows` → Ninja III). The rail, search keyboard and Settings two-pane layout are calm and consistent. Back restores focus every time it was tried.

---

## Tizen (2.1.x, `apps/tv-tizen`)

```
DESIGN REVIEW — Tizen (Odyssey G8, native 2580×1080 web surface)
USER ASKED FOR: same D25 brief

SCORES
  Craft (25):     20/25
    1. Subject presence   5/5  E   — backdrop + logo hero, first focus on the Continue card (tz-01-start); title page logo + poster (tz-21-title-movie)
    2. Composition        4/5  E   — ultrawide used well (rows run the full 2580 px, hero left third); library grid of 53 near-identical grey placeholders (data) and a bogus "TV Shows · 1 episodes" folder card (tz-22-shows-grid)
    3. Three layers       4/5  E   — backdrop image 78 %×88 % right-aligned + partial scrims + UI; clear depth (tz-02-rows)
    4. Palette discipline 4/5  E+C — tokens + sRGB fallback block, violet primary/ring; chips use border/secondary tokens consistently
    5. Typography         3/5  E+C — body runs on "Segoe UI"/SamsungOne fallback (eval: font=`"Segoe UI", SamsungOne, …`), tokens' Inter/Space Grotesk never loaded; many 10-foot sizes below 0.75 rem (13–17 px)
  Game feel (25): 15/25
    6. Choreographed entrance 2/5  C   — hero inner swaps with opacity/translate (home.css:8-9); no staged first paint
    7. Tactile interactions   4/5  E+C — card scale + ring overlay + glow, rail slides open (tz-04-rail), scrub bar thickens, A–Z scale 1.25
    8. Living background      3/5  E+C — decode-then-crossfade backdrop (Backdrop.tsx:57-62), still between moves
    9. Route morphing         3/5  C   — FLIP poster clone card→title (home.css "wt-flip") only from cards; keep-alive stack makes Back instant (back-restore key = same card)
    10. Subject artistry      3/5  E   — logos + chips good; placeholder = icon on flat grey; unmatched show opens straight into the player (tz-23b), no title page
  Discipline (10): 9/10
    11. Shell (TV-adapted)    5/5  E+C — keep-alive stack (Nav.tsx MAX_MOUNTED 6), SWR home cache (first paint 372 ms), virtual rows/grid, focus key restored on Back (eval back-restore)
    12. A11y + reduced motion 4/5  C+E — aria-labels on rail/buttons, aria-hidden decor, user motion pref `data-motion` (eval: motion=full, --dur-base .22s) zeroes durations; text below 10-foot minimum costs a point
TOTAL: 44/60

VERDICT
  ☐ Ship it (≥48)
  ☑ Polish pass needed (36–47)
  ☐ Redesign required (<36)
```

**What works:** the ultrawide layout. Rows, hero and title page look native at 21:9 with no pillarboxing. The Wildwood title page (`tz-21-title-movie`) is the strongest single screen on either TV: poster, logo, chips, actions and cast over a full forest backdrop. The OSD has a ring-focused control row, an "ends at" time and chapter markers (`tz-23b`).

---

## Issues, ranked

This score path is expected, not verified. Doing P1 plus P2 #9 should bring each surface to about 51–53. Android: +2 entrance, +1 typography, +1 composition (#5), +1 reduced motion, +1 artistry (#9). Tizen: +2 entrance, +1 typography, +1 composition (#7), +1 artistry (#9). Adding #8 (living background) should clear 52 on both. P0 here means ship-blocking against the brief. **No P0 was found:** every flow worked on device, and the gap to 52 is craft, not breakage.

### P1

| # | Surface | Screen | Issue | Fix |
|---|---|---|---|---|
| 1 | both | Home | **D25 breach: your own library comes after recommendations.** The server pushes `new_in_library` last, after `top_picks`, `trending_on_your_providers` and `upcoming`, so on device "Top picks for you" sits directly under Continue. | `server/src/media/recs.ts:342`: insert `new_in_library` straight after `continue` (`computed.unshift(...)` or build order `continue → watchlist → new_in_library → recs`). Watchlist is in `routes.ts:285`. One server change fixes both TVs and the web. |
| 2 | both | Home first paint | **No 3-act entrance.** Everything fades in at once (Android `HomeScreen.kt:210` AnimatedContent 220 ms; Tizen has no first-paint staging). | Stage it in three steps: backdrop opacity 0→1 (300 ms), then logo and chips (translateY 12 dp→0, 180 ms, +120 ms delay), then rows staggered 40 ms each (+240 ms). Android: `Modifier.graphicsLayer` alpha/translation driven by one `Animatable` in `ServerHome` (`HomeScreen.kt:339`). Tizen: `.wh-home.is-entering` class removed on rAF after first paint, with keyframes on `.wh-hero-inner` and `.vrow:nth-child(n)` (`home.css:7`), animating transform and opacity only. Skip it when motion is reduced. |
| 3 | both | all | **Typography has a single family.** The design system specifies a heading face (`--font-heading: "Space Grotesk"`), but neither TV loads it. Tizen body falls back to Segoe UI/SamsungOne (`styles.css:18`); Android uses system Roboto (`Typography.kt` sets no FontFamily). | Bundle a subset Space Grotesk woff2 (OFL) for Tizen: `@font-face` in `styles.css`, used by `.wh-name`, `.tv-h1`, `.vrow-title`. For Android, add `res/font/space_grotesk_*.ttf` and set `fontFamily` on `TvType.display…headlineSmall` (`Typography.kt:21-27`). This also improves the fallback when a title has no logo. |
| 4 | Android | all | **No reduced-motion path** (zero `reduc` hits in `ui/`). Tizen has a user motion pref; Android does not. | Add `motion` to profile prefs and a `LocalReducedMotion`. When it is set, `navTransition` returns `None` (`Nav.kt:217`), the backdrop Crossfade uses `tween(0)` (`Backdrop.kt:111`), the hero `animateFloatAsState` snaps (`HomeScreen.kt:339`), and card scale stays but the glow is off. Settings › Playback/Navigation gets the toggle (RO + EN strings). |
| 5 | Android | Title | **Primary CTA is "Back".** A title with no local file, trailer or offer shows `Back` as the focused primary button (atv-23-title-movie, "The Wolf and the Lamb", which is in Continue watching). The Home hero for the same card shows only "More info" (atv-21-home). | `TitleScreen.kt:216`: never render Back as primary. Fall back to `Mark as watched` / `My list` as the primary, or show an inline "File not on the server" chip (`MetaChips`) with Search as the action. Tizen solves this better with `canPlay` (`HomeHero.tsx:31`). |
| 6 | Tizen | 10-foot text | **Sizes below the 10-foot minimum** at a 24 px root on a 1080-px-tall panel: `.badge` 0.55 rem ≈ 13 px (`ui.css:117`), `.mcard-sub` 0.6 rem (`ui.css:131`), `.mcard-title` 0.72 rem (`ui.css:130`), `.wt-attrib` 0.58 rem, `.wt-offer-sub` 0.58 rem, `.wt-cast-role` 0.55 rem (`home.css`), `.wsr-hint` 0.6 rem. | Floor at 0.75 rem (18 px) for secondary text and 0.85 rem for card titles. Raise badges to 0.65 rem bold with more padding. Check that the row height still fits (`--poster-w` 9.5 rem). |
| 7 | Tizen | Library / Shows | **A bogus "TV Shows" show and a dead-end open.** A file whose parent is the library root gets grouped as a show named after the root ("TV Shows · 1 episodes", tz-22-shows-grid). Opening an unmatched show jumps straight into the player (tz-23b) with no title or season page. | `screens/home/library-data.ts:51` `showFolder`: when the resolved folder equals a scan root (or matches `/^(tv ?shows|seriale|series)$/i`), use the parsed show title from the file name instead. `screens/Library.tsx:148-154`: for `kind === "tv"` without tmdbId, push the existing `show` route (`{ name: "show", show }`, already used by `Home.tsx` ScanRows) rather than the player. |

### P2

| # | Surface | Screen | Issue | Fix |
|---|---|---|---|---|
| 8 | both | Home / Title | Living background: the backdrop is a still between focus moves. | Slow Ken Burns on the backdrop layer only: scale 1.0→1.05 over 24 s, alternate, transform only. Android: `graphicsLayer { scaleX/scaleY }` on the cached offscreen layer (`Backdrop.kt:92`), which is cheap because the texture is already cached. Re-measure `tv-jank.ps1`; keep it only if p50 stays ≤ 40 ms. Tizen: `@keyframes` on `.backdrop-img.on` (`ui.css:39`). Off when motion is reduced. |
| 9 | both | Library / cards | Placeholder art is flat. Android uses an accent gradient with text (`PosterCard.kt:118`), Tizen an icon on grey (`Library.tsx:235`). | Use the still frame that already exists: `ctx.client.stillUrl(fileId)` (Tizen ScanRows already does this, `Home.tsx:212`) and `/video/thumbs/:id/still.jpg` on Android, under a bottom scrim with the guessed title in the heading face. |
| 10 | Android | Title | The logo and the top of the poster are clipped when the page opens with a long body (atv-23-title-movie). The LazyColumn scrolls to bring the focused button into view. | `TitleScreen.kt:171`: keep the top item pinned. Request focus after `listState.scrollToItem(0)`, or give the primary row `Modifier.bringIntoViewRequester` with top padding so the logo stays visible. |
| 11 | both | Profile picker | Flat dark page, a single avatar centred with no atmosphere (atv-31-profiles, tz-12-profiles). | Reuse the backdrop with the last-watched backdrop blurred or dimmed at intensity 0.35 (`LocalBackdrop.current.intensity` on Android; Tizen `useBackdrop().show(...)` plus a stronger scrim). Give avatars a profile-colour ring. |
| 12 | Android | Player OSD | The OSD uses scrims only. Glass (`PlayerOsd.kt:82` popover 78 % + border) is applied to panels and pills but not to the control row, so the control row floats on the gradient (atv-33-osd). | Put the transport row and the time on one glass strip (`Modifier.glass()`), max width about 1400 dp, centred. That matches the "glass OSD" wording in D25. |
| 13 | Tizen | Player OSD | Control icons have no labels until focused, and `pl-times` is 0.75 rem (tz-23b). | Show the focused button's label under it (already done), and raise `.pl-times` to 0.85 rem. Add a glass background to `.pl-controls` to match Android. |

## Regressions vs previous version
None observed against WP15: the 21:9 squeeze still works (Android UI squeezed in the 16:9 screencap as designed, Tizen native 2580×1080), HLS/OSD and resume label ("Resume S2 E1 · 12 min left", atv-33c) intact.

## Prescriptions in priority order

These are the top 3 that move the score most.
1. `server/src/media/recs.ts:342` — move `new_in_library` ahead of the recommendation rows. This closes the D25 breach on every surface.
2. `HomeScreen.kt:339` and `home.css:7` — add the 3-act Home entrance (backdrop → logo/chips → staggered rows), skipped when motion is reduced. Worth +2 on criterion 6 for each TV.
3. Load the heading face on both TVs (`Typography.kt`, `styles.css`) and raise Tizen 10-foot text sizes (`ui.css:117,130,131`, `home.css`). Worth +1 on criterion 5 for each, and +1 on criterion 12 for Tizen.

Then fix Android #4 and #5, and Tizen #7.

## User-intent gap
**Partial.** Both TVs deliver the core D25 look: a full-bleed backdrop that follows focus, TMDB logo treatment, honest chips, and fast restoring navigation. The gaps are the library-before-recommendations order (server), the entrance and background motion that separate "cinematic" from merely "dark with a backdrop", and a heading typeface. The glass OSD is only partly applied on Android.

## Screenshots (`.copilot-tmp/critic/`, not committed)
- Android, scrims on (shipping look): `atv-21-home`, `atv-22-rows`, `atv-23-title-movie`, `atv-31-profiles`, `atv-32-search`, `atv-33-osd`; uiautomator text in the matching `.xml` files and `a6.log`/`a7.log`.
- Android, captured with `noscrim` (layout and text evidence only): `atv-01-start`, `atv-02-rows`, `atv-04-rail`, `atv-05-library`, `atv-06-shows`, `atv-07-music`, `atv-08-live`, `atv-09-settings`, `atv-10-movie`, `atv-11-show`, `atv-11c-episodes`.
- Tizen: `tz-01-start`, `tz-02-rows`, `tz-04-rail`, `tz-05-library`, `tz-08-search`, `tz-09-music`, `tz-10-live`, `tz-11-settings`, `tz-12-profiles`, `tz-21-title-movie`, `tz-22-shows-grid`, `tz-23b-title-show-episodes` (player OSD); CDP text and focus keys in `tz-out.json` and `tz-out2.json`.
