# MixAI Design System

> Source of truth for how every MixAI surface looks and behaves — web (PWA), MixAI DJ (Tauri),
> Companion (Electron), native shell (Tauri/Capacitor), TV (Tizen web + Android Compose) and the
> browser extension. Code lives in `packages/design-tokens` (data) and `packages/ui` (components).
> Progress and decisions: `docs/mixai-design-tracker.md`.

## 1. Principles

1. **One token source.** Colours, radii, motion, breakpoints and theme dimensions are declared once
   in `packages/design-tokens/src/tokens.ts` and generated into every format a surface can read.
   Hand-typed hex values in app code are a bug.
2. **Hue is the only thing a user changes about colour.** Every role (primary, ring, chart-1,
   sidebar-primary…) is an OKLCH triple whose hue is `var(--accent-h)`. Lightness/chroma are fixed
   per mode so any accent — including a user-picked hue or one sampled from cover art — stays
   accessible.
3. **Dimensions, not themes.** A theme is the product of independent axes (mode × accent × surface ×
   density × radius × motion). Each axis is a `data-*` attribute on `<html>`; CSS reacts to the
   attributes, never to a "theme name".
4. **No flash, ever.** `prehydrate.js` (1 KB, ES2017) runs before first paint on every web-based
   surface and writes the attributes from `localStorage["mixai:prefs:v1"]`.
5. **Skeletons match layout.** Every streaming boundary renders a skeleton with the same box
   geometry as the final content (no CLS). Spinners only for indeterminate sub-second work.
6. **Native feel per platform.** Mobile: safe areas, bottom tab bar, sheets, 44 px targets.
   Desktop: keyboard-first, command palette, dense tables. TV: 24 px root, 4 px focus ring,
   overscan margins, D-pad spatial navigation.
7. **Ultra-wide is a first-class viewport.** Reading columns cap at `--content-lg/xl`; lists become
   multi-column via container queries; the shell centres itself above 240 rem.

## 2. Brand — "Neon Nocturne"

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` | `#7c5cff` | `#8b6dff` | logo, splash, marketing — never re-hued |
| `--brand-2` | `#e84ff0` | `#ef62f3` | second stop of the signature gradient |
| `--brand-accent` | `#22d3ee` | `#38dcf2` | wordmark "AI", live indicators |
| `--brand-gradient` | violet → magenta 135° | | hero, badges (`Badge variant="gradient"`) |
| `--deck-a/b/c/d` | cyan / pink / lime / amber | | MixAI DJ deck colours (fixed, D9) |

Neutrals carry a faint indigo bias (hue 285, chroma 0.004–0.02) and dark-mode text is warm ivory
(`oklch(0.96 0.01 80)`), never pure white.

## 3. Theme dimensions

| Attribute | Values | Default | Notes |
|---|---|---|---|
| `data-mode` | `light` `dark` | resolved from pref `system` | `.dark` class is also set for legacy selectors |
| `data-accent` | `violet` `magenta` `cyan` `emerald` `amber` `rose` `custom` `artwork` | `violet` | `custom`/`artwork` write `--accent-h` inline |
| `data-surface` | `glass` `solid` `flat` | `glass` (desktop) / `solid` (coarse pointer) | drives `--surface-alpha/-blur/-shadow/-glow` |
| `data-density` | `comfortable` `compact` | `comfortable` | `--control-h`, `--row-h`, `--text-scale` |
| `data-radius` | `sm` `md` `lg` | `md` | `--radius` 0.375 / 0.625 / 1 rem |
| `data-motion` | `full` `reduced` | `full`, forced `reduced` by `prefers-reduced-motion` | zeroes `--dur-*` |
| `lang` | `ro` `en` | `ro` | mirrored to the `mmo-locale` cookie on web |
| `data-tv` | present | — | 10-foot overrides |

Persisted shape (`ThemePrefs`): `{ mode, accent, surface, density, radius, motion, locale, feedback }`.
`feedback` enables haptics + sound cues (`useHaptics()`).

Migration: `theme` (web v1), `mixai-ui` (MixAI DJ zustand blob: `flat-pro`→flat, `studio-metal`→solid,
`minimal`→reduced) and the `mmo-locale` cookie are read once when `mixai:prefs:v1` is absent.

## 4. Generated artefacts

`pnpm -C packages/design-tokens build` (also `pnpm tokens:build` at root) writes:

| File | Consumers |
|---|---|
| `dist/tokens.css` | web, mixai, companion — Tailwind v4 `@theme inline`, custom variants (`dark`, `glass`, `solid`, `flat`, `compact`, `tv`, `standalone`, `ultrawide`, `motion-full`), utilities (`surface`, `surface-glow`, `skeleton`, `content-*`, `pb-safe`, `overscan`, `focus-ring`, `text-gradient-brand/accent`, `bg-gradient-accent`) |
| `dist/tokens.plain.css` → `apps/tv-tizen/src/tokens.css`, `apps/extension/tokens.css`, `apps/native/web/tokens.css` | vanilla pages |
| `dist/Tokens.kt` → `apps/tv-android/.../ui/theme/Tokens.kt` | Compose `object Tokens` (dark, violet) |
| `dist/prehydrate.js` → `apps/web/public/`, `apps/tv-tizen/public/` | `<script src="/prehydrate.js">` in `<head>` |
| `dist/tokens.json` | tooling / tests |

CI (`web-ci.yml`) fails if the committed output differs from a fresh build.

## 5. `@mmo/ui`

Base UI (`@base-ui/react`) primitives styled with Tailwind v4, shadcn-compatible names so migration
from Radix is mechanical. Differences from Radix you will hit:

- `asChild` → `render={<Link href=… />}` (Base UI `useRender`).
- `onOpenChange(open, eventDetails)`, `onValueChange(value, eventDetails)` — second arg is new.
- State attributes: `data-open`, `data-checked`, `data-highlighted`, `data-starting-style`,
  `data-ending-style` (not `data-state=…`).

Families: **theme** (`ThemeProvider`, `useThemePrefs`, `useTheme` legacy shape, `applyPrefs`,
`dominantHueFromImage`), **layout** (`AppShell`, `Sidebar*`, `BottomTabBar`, `Page`, `PageHeader`,
`PageSection`), **feedback** (`Skeleton*`, `EmptyState` + `NotSignedInState` / `NoCompanionState` /
`ErrorState` / `NoResultsState`, `Progress`, `ProgressJob`, `Toaster`), **data** (`DataTable` on
TanStack Table 9 with column priority + mobile cards), **overlays** (`Dialog`, `Sheet`,
`AlertDialog`, `Popover`, `Tooltip`, `DropdownMenu`, `ContextMenu`, `CommandDialog`,
`ShortcutsOverlay`), **forms** (`Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `Slider`,
`RadioGroup`, `ToggleGroup`, `Field*`), **settings** (`ThemeSettings`, `ThemePreview`), **motion**
(`fade`, `rise`, `scale`, `slideUp`, `stagger`, `PageTransition`), **hooks** (`useMediaQuery`,
`useIsMobile`, `useIsUltrawide`, `useIsStandalone`, `useSafeArea`, `useHaptics`,
`useContainerSize`), **shortcuts** (`registerShortcut`, `useRegisterShortcut`, `formatKeys`).

Consumption is via tsconfig `paths` (repo convention, `packages/README.md`). Apps must dedupe
`react`, `react-dom`, `motion`, `@base-ui/react` to their own `node_modules` (see
`apps/web/next.config.ts` `turbopack.resolveAlias` and `vitest.config.ts` `resolve.dedupe`),
otherwise hooks fail with "Cannot read properties of null (reading 'useState')".

## 6. Layout rules

- Content widths: `content-sm` 40 rem (forms), `content-md` 56 rem (reading), `content-lg` 80 rem
  (dashboards), `content-xl` 100 rem (dense tables), `full` (canvases: DAW, mixer, player).
- Breakpoints: Tailwind defaults + `3xl` 120 rem, `4xl` 160 rem; variant `ultrawide:` for
  `min-aspect-ratio: 21/9`.
- Mobile shell: `BottomTabBar` (5 slots + "More" sheet) above the mini-player; `--shell-bottom-offset`
  exposes the stacked height so pages can pad (`pb-safe-*`).
- Z-index scale (`--z-*`): base 0, raised 10, sticky 20, sidebar 30, player 40, overlay 50,
  modal 60, popover 70, toast 80, tooltip 90.
- TV: `overscan` utility (5 vw / 4 vh), `--focus-ring-w` 4 px, `--card-scale-focused` 1.06.

## 7. Motion

Tokens: `--dur-fast` 120 ms, `--dur-base` 220 ms, `--dur-slow` 400 ms, `--dur-page` 320 ms;
`--ease-out` (0.16,1,0.3,1), `--ease-in-out`, `--ease-spring` (linear() spring). All become 0 ms /
linear under `data-motion="reduced"`.

- Route changes: React 19.3 `<ViewTransition>` (Next App Router, no config) with the cross-fade in
  `@mmo/ui/styles.css`; mixai/companion use `<PageTransition>`.
- Entrances: `animate-fade-in`, `animate-rise-in`, `animate-scale-in` utilities or the `motion`
  presets; lists use `stagger()`.
- Decorative motion is only in `motion-full:` and only on hero/NowPlaying surfaces.

## 8. Accessibility

WCAG 2.2 AA. Every accent hue yields ≥ 4.5:1 for `primary-foreground` on `primary` by construction
(L 0.62/0.70 vs 0.99/0.14). Focus is always visible (`:focus-visible` outline in `--ring`; 4 px on
TV). Touch targets ≥ 44 px (checkbox/switch/radio/slider thumbs pad their hit area). Reduced motion
honoured. `EmptyState tone="error"` has `role="alert"`.

## 9. Adding a surface

1. `@import "tailwindcss"; @import "<path>/design-tokens/dist/tokens.css"; @import "<path>/ui/src/styles.css"; @source "<path>/ui/src";`
2. Inline or load `prehydrate.js` in `<head>`.
3. Wrap the tree in `<ThemeProvider>`; add `<ThemeSettings />` to the settings screen.
4. Add path aliases `@mmo/ui`, `@mmo/design-tokens` and the React dedupe.
5. Register the surface in `docs/mixai-design-tracker.md`.

For non-web surfaces use `tokens.plain.css` / `Tokens.kt` and keep the same attribute names.
