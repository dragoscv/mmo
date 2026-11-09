# Skins and design system (WP19-18)

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
