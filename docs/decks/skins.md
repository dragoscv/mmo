# Skins and design system (WP19-18, Decks 1.5 look)

Two parts: the desktop app `apps/mixai` (Tauri), where the Decks 1.5 look lives, and the native apps
(Compose / SwiftUI), further down. State described: Decks 1.5.0 (2026-11-11); every item below says
whether it is built or planned.

## Desktop app (Tauri): look, skins, style

### The default: MixAI Signature (built)

Black-green, flat, dense. Green is every ON state; colour is kept for data (deck identity, waveforms,
hot cues). Code: `apps/mixai/src/look/` (`look.css`, `look.ts`, `style-vars.ts`, `canvas-colors.ts`).

- `<html data-look="signature">` is the default; `data-look="classic"` switches the whole layer off, so
  the shared design tokens show through (the 1.x glass look). The look is Decks-only: the shared tokens
  in `packages/design-tokens` are not changed.
- Theme dimensions of the default (`SIGNATURE_PREFS`): mode `dark`, accent `emerald`, surface `flat`,
  density `compact`, radius `sm`. They are applied once per install (`migrateLookOnce`, flag
  `mixai-look-v2`), before first paint, to new and existing installs alike; an accent the user had
  chosen is kept (only the old default `violet` is replaced).
- Dark colours (`look.css`): background `oklch(0.1 0.008 165)`, panel (`card`) `oklch(0.165 0.01 165)`,
  raised control (`secondary` / `muted`) `oklch(0.24 0.012 165)`, line (`border`)
  `oklch(0.285 0.012 165)`, text `oklch(0.96 0.006 165)`, muted text `oklch(0.74 0.012 165)`, third text
  level `oklch(0.65 0.012 165)`, ON / primary `oklch(0.8 0.19 <accent hue>)`.
- Geometry: title bar 36 px, status bar 22 px, shell padding 4 px, panel gap 2 px, panel radius 2 px,
  panel padding 8 px, control and pad radius 3 px, control height 24 px. No blur, glow or drop shadow.
- Waveforms use three tones of the deck colour (low band darker, high band lighter) unless a skin
  fixes the band colours; PLAY takes the deck colour inside a deck.
- Fonts bundled with the app: Inter and JetBrains Mono (variable, `@fontsource-variable/*`,
  SIL OFL 1.1).
- Booth mode (title bar BOOTH, or Settings → Appearance): readouts ×1.3, control height 28 px,
  brighter muted text and lines. Virtual platter: Settings → Appearance, off by default; a skin can
  turn it on. Colour-blind-safe hot cue palette: Settings → Appearance.

### What a skin is and what it changes (built)

A skin is a `PackInfo`: either built into the app (`apps/mixai/src/packs/builtin-skins.ts`) or an
installed `.mixaipack` (format and every key: [packs.md](packs.md)). Its `tokens.json` has two layers:

| Layer | Keys | Needs |
|---|---|---|
| Theme | `mode`, `surface`, `density`, `radius`, `accent`, `colors` (24 theme colours), `decks` (a–d), `fontHeading`, `fontBody`, `background` | manifest `v` 1 |
| Style | `style.look`, `style.platter`, `style.layout`, `style.waves`, `style.colors` (25 keys), `style.sizes` (8 keys) | manifest `v` 2, Decks 1.5 |

How it is applied (`tokensToCss` in `packs/apply-tokens.ts`, `renderSkin` in `packs/pack-store.ts`):

- Colours and sizes become one rule `:root[data-skin] { … }` in `<style id="mixai-skin">`; `data-skin`
  on `<html>` is the pack id. Every value is re-checked first; one that fails is dropped, never written.
- `style.look` sets `data-look`; `style.platter: true` sets `data-skin-platter="on"`; `style.waves:
  "overlay"` sets `data-skin-waves="overlay"`.
- Theme dimensions go on top of the prefs the user had **before** any skin; those are kept
  (`mixai-skin-base-prefs`) and come back when the skin goes away. Switching between skins never stacks
  their prefs.
- **Layout.** A skin with `style.layout` switches to that layout when the user picks it, and the layout
  it replaced is remembered (`mixai-skin-base-layout`). Leaving the skin brings that layout back, unless
  the user chose another layout while the skin was on. A startup render and the 30 s try never switch
  the layout.
- The active skin id is stored in localStorage `mixai-skin`. "MixAI (default)" in Settings → Appearance
  clears it: the Signature look and the user's own prefs and layout return.
- Try 30 s: preview only (nothing saved, timer extendable); keeping it installs and activates the skin.
- Install shows the contrast problems of the five theme pairs (`contrastProblems`: text 4.5:1, focus
  ring 3:1).

### Built-in skins

`BUILTIN_SKINS`, in picker order. The first four are new in 1.5 and covered by
`apps/mixai/src/packs/builtin-skins.test.ts` (validation, layout resolution, contrast, naming rule).
Colour values are not listed here: read the file.

| Skin | id | Look | Layout it selects | Waves | Platter | Notes |
|---|---|---|---|---|---|---|
| Mainroom | `ro.mixai.skin.mainroom` | signature | `pro` | stacked | — | black window, flat neutral greys, one blue for every ON state, waveform in fixed blue tones, all decks the same colour |
| Crate | `ro.mixai.skin.crate` | signature | `pro-vertical` | stacked | on | warm dark grey with black wells, waveform bands red (low) / green (mid) / blue (high), its own eight hot cue colours |
| Pilot | `ro.mixai.skin.pilot` | signature | `pro` | overlay | on | blue-grey, deck A blue and deck B red, waveform in tones of the deck colour, all decks in one lane |
| Glass (classic) | `ro.mixai.skin.glass-classic` | classic | `classic` | stacked | — | the Decks 1.x look: glass surface, violet accent, comfortable density, large radius |
| Colour-safe decks | `ro.mixai.skin.okabe-ito` | signature | — | stacked | — | deck colours only (Okabe–Ito) |
| High contrast | `ro.mixai.skin.high-contrast` | signature | — | stacked | — | black and white, solid surface |
| Booth | `ro.mixai.skin.booth` | signature | — | stacked | — | warm amber, solid surface, large radius |
| Studio light | `ro.mixai.skin.studio-light` | signature | — | stacked | — | light mode, flat, comfortable density |

"—" under Layout = the skin keeps the current layout; under Platter = the user's own setting decides.
The first four carry a `style` block and therefore manifest `v` 2; the other four are `v` 1.

On screen (2026-11-11, dev build on a laptop, window 1500×969): each of the four was applied, no element
sticks out of its panel, and `setActiveSkin(null)` brought back the Signature look, the prefs dark /
emerald / flat / compact / sm and the layout `pro`. Light mode was not looked at.

Names and descriptions of the built-in skins are translated (`skins.b.<slug>.name` / `.desc` in
`i18n/messages-skins.ts`, resolved by `packs/skin-text.ts`); an installed pack shows the text its
author wrote.

Tints (hover, zebra rows, selected fills) are mixed with `color-mix(in oklab, …)`. Mixing in oklch
interpolates the hue, which bent tinted greys (pink zebra rows, an olive selection); oklab is a
straight line between the two colours.

First-run tour, step "Coming from another app?" (built): rekordbox → Mainroom, Serato → Crate,
VirtualDJ → Pilot, "New to DJ software / keep MixAI" → the default. A choice whose skin is missing from
`BUILTIN_SKINS` is shown as unavailable.

### Legal note: look-alike skins

- Names are neutral (Mainroom, Crate, Pilot). No product or company name appears in a skin name or id.
- A description may name another product only in the form "Familiar to <product> users; not affiliated
  with or endorsed by <company>." The descriptions in the file name AlphaTheta (rekordbox), Serato and
  Atomix Productions (VirtualDJ).
- No logos and no artwork of other products. The skins follow screen conventions (which grey is a
  panel, where colour is allowed, how a waveform is tinted); the colours are MixAI's own picks.
- The tour shows the product names as text with the line "rekordbox, Serato and VirtualDJ are trademarks
  of their owners. MixAI is not affiliated with them."
- Enforced by the test "descriptions name another product only with the non-affiliation wording; names
  stay neutral" in `builtin-skins.test.ts`. This is an engineering rule, not legal advice.
- The existing skin "Booth" keeps its name.

### Live skin editor (built)

Settings → Appearance → "Create / edit a skin" closes Settings and opens a floating, non-modal panel
over the running app (the app is the preview). Code: `apps/mixai/src/settings/SkinEditor.tsx`,
`settings/skin-editor/{model,store,color,effective}.ts`, `settings/skin-editor.css`.

- **Groups** (tabs, none scrolls): Base (start from a skin, mode, accent, surface, density, radius),
  Colours (surfaces / text / states), Decks, Waveform, Hot cues, Shape (the size keys), Options
  (look, layout, waveform arrangement, platter).
- **Preview** = the pack store's own preview path (`renderSkin(pack, { persist: false })`, the call a
  30 s try uses), one render per frame. Nothing is saved until "Save as my skin"; closing (button or
  Esc with focus inside) brings back the skin, prefs and layout from before.
- **Colour fields**: native picker + text (`#rrggbb[aa]` or `oklch(L C H [/ A])`), "back to automatic"
  per field. A colour with no visible tint (OKLCH chroma < 0.004) is stored as hex, any other as
  `oklch()`.
- **Contrast**: the same pairs as the install dialog, recomputed on every change against the colours
  the running app really shows for unset fields.
- **Save as my skin**: builds an unsigned manifest `v` 2 pack with `pack_build`, installs and activates
  it as `user.skin.<slug of the name>`; saving again under the same name raises the patch version.
- **Export .mixaipack**: `pack_export` (native save dialog). In the browser preview both answer
  "only in the desktop app".
- The panel moves by its header or with the arrow keys on the move handle. A crash inside the editor
  closes it and undoes the preview; the app keeps running.

Verified on a dev build (2026-11-11): typed and picked colours, the contrast list, sizes, options,
reset, Esc, save twice (1.0.0 then 1.0.1), entry button. The native save dialog of Export was not
driven by a test.

## Native apps (Compose): skins from the design tokens

State of the Decks 1.5 look in the native apps (2026-11-11):

- **Compose (Android + desktop), partly built.** The Signature palette and geometry are the default
  (`theme/Look.kt` mirrors the `look.css` numbers); the old scheme is the preset `glass-classic`;
  Mainroom, Crate and Pilot exist as presets with the desktop colours, sizes and layouts; a skin saved
  by 1.4 moves once to Signature + Pro (a chosen accent or layout is kept); layouts with a `waves`
  area place the existing waveform lanes as a panel. Not built: the redesigned deck / mixer / library
  content (the panels keep their 1.4 content, shown at the richest tier that fits), the ON / PLAY
  colour roles in controls, vertical and overlay waveforms, the platter, applying the `style` block of
  an installed pack. Desktop tests green (`:decks-ui:desktopTest`, 90 tests); no device run.
- **SwiftUI, compile fixes only, not compiled** on this PC: `LayoutHost.swift` knows the `waves`
  panel, the default layout comes from `layoutDefaultId()`.

The rest of this part describes the token-derived skin model the native apps share.

Native Decks apps (Android `:decks`, desktop `:decks-desktop`, shared `:decks-ui`) are themed only
from `packages/design-tokens`. A **skin** is a set of token dimensions plus a layout preset:

| Field | Values (from tokens) | Effect |
|---|---|---|
| mode | dark / light | role table `TokenRoles.dark` / `.light` |
| accent | violet, magenta, cyan, emerald, amber, rose | re-tints every `h: accent` role (primary, ring, chart-1…) |
| surface | glass / solid / flat | panel alpha |
| density | comfortable / compact | control height (40 / 34 dp, never under the 44 dp touch target), text scale |
| radius | sm / md / lg | control and panel corners |
| motion | full / reduced | ORed with the OS setting |
| layout | classic / performance / library | classic: deck A, mixer, deck B, library below; performance: tall waveforms, no jogs; library: library first, decks condensed |
| contrast | high contrast flag | muted text and borders use the foreground role, opaque panels |

Deck identity colours (A cyan, B magenta, …) and Camelot key colours are brand-fixed and never re-hued.

## How colours are made

`pnpm tokens:build` writes `apps/mobile-android-common/.../theme/TokenRoles.kt` (OKLCH numbers +
dimensions, generator `kotlinRoles`) next to `Tokens.kt`. `:decks-ui:syncTokens` mirrors both.
`DecksPalette` converts OKLCH → sRGB at runtime with the same OKLab constants and rounding as
`oklchToHex`; `SkinTest.runtimeOklchMatchesGeneratedTokens` proves the default skin is bit-identical
to `Tokens.kt`. No colour literal exists in Decks UI code (hex gate).

## Presets

`nocturne` (default, dark violet), `club` (magenta, flat, compact, performance layout), `booth`
(amber, high contrast, large radius), `studio` (light, library layout), `emerald` (glass, compact).
`SkinTest.everyPresetMeetsWcagAaForText` checks for every preset: body text 7:1 on the background,
4.5:1 on panels, labels 4.5:1, text on primary buttons 4.5:1, focus ring 3:1.

## Switching and persistence

- Status bar button "Skin: <name>" and **Ctrl+K** cycle presets (keyboard + TalkBack/Narrator labelled).
- Android: SharedPreferences `decks/skin`; desktop: `java.util.prefs` node `ro/mixai/decks`, override
  `-Ddecks.skin=<id>`. Stored as `DecksSkin.encode()`; `decode` ignores unknown or invalid fields.

## States

Track loading shows the engine phase (queued → decoding → analysing beats and key → ready / failed),
RO + EN. Reduced motion stops the jog rotation, beat pulses and the scrolling grid.

## Screenshots

`:decks-ui:desktopTest` renders `build/screenshots/decks-skin-<id>.png` for every preset.

## Open

- SwiftUI app (apps/ios/DecksApp) still uses its own `DecksTheme.swift` on `Tokens.swift`; port the
  skin model there (needs an OKLCH role table in `swiftTokens`).
- Haptic beat (Android vibration on the master downbeat, opt-in via the `feedback` pref).
