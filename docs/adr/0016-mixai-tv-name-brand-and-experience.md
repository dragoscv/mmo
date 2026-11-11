# ADR-0016 — MixAI TV name everywhere, family rebrand, cinematic TV experience

- Status: Accepted · 2026-11-11 (owner decisions D71–D77, two question rounds)
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) §15 (WP22)
- Related: [ADR-0008](0008-design-system-and-theme-prefs.md) (tokens), [ADR-0013](0013-product-family-and-domains.md)
  (product family; amended here), [`docs/arhitectura/app-inventory.md`](../arhitectura/app-inventory.md)

## Context

Audit of 2026-11-11 (five read-only research passes; full reports in the local scratch folder
`.copilot-tmp/tv-brand/research/`, summary in tracker §15):

- **Name.** TV, desktop and web watching surfaces already show "MixAI TV". The Android phone app, the iPhone app
  (widgets, watch) and the App Store record are still "MixAI". Apple TV ships inside that record, and an App Store
  record has one name for all its platforms, so Apple TV is listed as "MixAI" too. Nothing is published on
  Google TV, Fire TV, Samsung or LG.
- **Brand.** Palette and fonts come from one source (`packages/design-tokens`). There is no brand pack, no master
  mark that icons are generated from and no logo motion. Five different marks are in use (waveform squircle on
  web, play triangle on Android, note + Wi-Fi on the server, "TV" on a blue circle on Tizen, pink note on Live
  desktop). The iOS Decks and Live targets have no app icon. Tracker item WP17-03 was never started.
- **TV experience.** Android TV, Tizen / TV desktop and web are close to parity and already have a poster morph,
  skeletons and Ken Burns backdrops. Apple TV lacks skip markers, Up Next, trick-play, speed, sleep timer, the
  guide and DVR, Watch Together, a profile editor, QR onboarding, skeletons, entrance motion and reduced-motion
  handling. No TV client can search or download subtitles although the server serves it and both phones use it.
  No client shows an image placeholder before a poster loads.
- **Platform limits.** tvOS has no zoom navigation transition (Apple: "not supported in tvOS"). Same-document View
  Transitions need Chromium 111: Samsung 2025+ (M120) and LG 2025+ (Chromium 120) only; 2020–2024 sets need
  hand-written transform and opacity transitions. Android 12+ system splash accepts only an
  `AnimatedVectorDrawable` (Google recommends at most 1 s). iOS and tvOS launch screens cannot animate.
- **Risks.** "MixAI" is a registered EU word mark of a third party (EUTM 019096089, Octagon I/O LTD, registered
  2025-02-21, classes 9, 37, 42; the class 9 list includes unrestricted "Computer software; Computer software
  applications"; their business is construction sensors). The App Store cannot sell the app in the 27 EU
  storefronts until the trader verification passes (WP16-48).

## Decision

1. **Name (D71).** Keep the family name MixAI. Every watching client is named **MixAI TV**, phones included, now.
   A trade mark attorney's opinion on EUTM 019096089 is sought in parallel (owner).
   - Android phone: launcher label, in-app texts that name the app, Play listing title in every language.
   - Apple: `CFBundleDisplayName` on iPhone, widgets and watch; App Store record name and subtitle. The record
     name changes with new iOS and tvOS versions, after the tvOS 1.1.0 review ends.
   - Application ids do not change (`ro.mixai.app`).
2. **Google TV (D72).** One Google Play listing. The Android TV app moves from `ro.mixai.tv` (never published) to
   `ro.mixai.app` and is released on the listing's Android TV track, signed with the phone upload key. Planned
   mechanism: a separate TV bundle that requires `android.software.leanback`, with its own version-code range;
   confirm it in Play Console before the id switch, otherwise merge both into one bundle. Sideloaded
   `ro.mixai.tv` installs need a reinstall and a new pairing. Fire TV uses the same build and id.
3. **Rebrand depth (D73).** New mark, new icon family, logo motion and a fixed accent colour per product
   (TV, Music, Decks, Live, Studio, Key & BPM, Server, Connector). Neutrals, the base palette and the fonts
   (Space Grotesk, Inter, JetBrains Mono) stay.
4. **Family structure (D74).** Open until the comparison sheet: both structures are drawn (one parent mark with a
   glyph and colour per product; one mark with colour only) and the owner picks on rendered images.
5. **Brand pack.** `brand/brand.json` + `brand/BRAND.md` + master SVGs in `brand/logo/` become the source of
   truth. One generator produces every platform export; per-app icon scripts and hand-made copies are retired.
   A drift gate fails when a committed export differs from the generated one.
6. **Logo motion (D75).** One parametric source (mark geometry + motion tokens) generates the native form on each
   platform: `AnimatedVectorDrawable` (Android splash and in-app), CSS / animated SVG (web, Tizen, webOS, Tauri),
   SwiftUI (iOS, tvOS, watchOS), Lottie only for store video. Set: intro, loading, success, error, press, morph
   from splash into the first screen. The static mark equals the first and the last frame. Every animation has a
   reduced-motion variant. No runtime dependency (Rive and Lottie players rejected, see Alternatives).
7. **Sonic signature.** A short brand sound at start on the TV apps, with a setting to turn it off.
8. **TV design direction (D76).** Cinematic immersive, an evolution of the current screens: backdrop and details
   follow focus, title logo art, poster-to-page morph, glass on player and overlay chrome, trailers only on
   request, never autoplay with sound.
9. **Motion architecture.** Share values, not code: durations, easings, springs, focus scale and reduced-motion
   variants live in `packages/design-tokens` and are generated for Kotlin, CSS and Swift.

   | Platform | Mechanism |
   |---|---|
   | Android TV, Android phone | Compose `SharedTransitionLayout` (`sharedElement`, `sharedBounds`), `AnimatedContent` |
   | Apple TV | system focus effects, in-screen `matchedGeometryEffect`, `glassEffect` + `GlassEffectContainer`; no zoom navigation |
   | iPhone | `navigationTransition(.zoom)` + `matchedTransitionSource` |
   | Web | React `<ViewTransition>` for routes and Suspense reveals, Motion `layoutId` where a morph must be interruptible |
   | Tizen, webOS | transform and opacity FLIP as the baseline; View Transitions behind a feature check (Chromium 111+) |
   | TV desktop (Tauri) | the web path; feature check on macOS |

10. **Loading and progress.** One spec for every client: skeletons shaped like the content, an image placeholder
    computed by the server (ThumbHash or dominant colour) for posters and backdrops, a progress indicator for
    anything longer than 1 s and an estimate beyond 10 s, poster-to-video crossfade at playback start.
11. **Accessibility.** Focus is never scale-only or glow-only: a border of at least 2 px with 3:1 contrast.
    Subtitle controls sit at the same level as the main player controls. Clients apply the system caption style
    where the platform exposes one.
12. **Order (D77).** Phase 1: rename + brand pack + roll-out. Phase 2: TV design and parity on every platform.
  Phase 3: the eleven ideas the owner selected (tracker WP22-16 and WP22-40..49).

## Consequences

- Positive: one product name on every store and screen; one Play listing and one rating; the TV build finally has
  a signing key (the phone upload key); every icon and animation comes from one source; Apple TV reaches the
  level of the other TVs.
- Negative: every app ships at least one release only for the new identity; existing sideloaded Android TV
  installs must be reinstalled; in one Play listing a rejected TV build can hold back phone updates; if the
  trade mark opinion is unfavourable the family name changes and the wordmark work is redone.
- Out of scope: a new base palette or new fonts; Roku; a Vega OS (React Native) Fire TV client.

## Alternatives

- **Pause the rename until the trade mark opinion.** Rejected by the owner: the app is already published as
  "MixAI", so "MixAI TV" adds no exposure.
- **Two Play listings (`ro.mixai.app` + `ro.mixai.tv`).** Independent reviews, but two listings with the same
  name, split ratings and duplicated texts. Google recommends one app for mobile and TV.
- **Rive or Lottie players everywhere.** One file per animation, but a runtime in every app, not allowed in the
  Android system splash, and not confirmed on real Samsung sets.
- **Rebrand from zero (palette, fonts, tone).** Every screen of every app would be re-verified for contrast,
  glyph coverage and design score.
- **Calm editorial or dense decision-first TV layouts.** Kept as references; the owner chose cinematic immersive.
