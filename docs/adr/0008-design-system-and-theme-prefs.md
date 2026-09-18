# ADR-0008 — Shared design system: OKLCH tokens, Base UI, one prefs blob per user

- Status: Accepted · 2026-09-18
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) · Spec: [`docs/design-system.md`](../design-system.md)

## Context

Before the 2026-09 overhaul MixAI shipped **five unrelated palettes** across its surfaces —
web `#7c5cff`/`#a855f7` (hardcoded ~26×), MixAI DJ green `#00e08a` with three dark-only skins,
the native shell and Companion `#a855f7`, Tizen `#7c5cff`, the extension `#9333ea` — and
**three different preference stores**: web `localStorage["theme"]` (custom provider, `<html
class="dark">` hardcoded so light mode flashed), MixAI DJ `mixai-ui` (zustand skin blob) and
the `mmo-locale` cookie. Every surface was **dark-only** in practice, none exposed accent,
surface, density or radius, and the TV apps carried ~40 literal `Color(0xFF…)` values in
Compose. `next-themes` was installed but unused; the web UI kit was shadcn `radix-vega`
(21 primitives on `@radix-ui/*`, `asChild`), `framer-motion` 12 on web and declared-but-unused
in MixAI DJ.

Adding a feature meant restyling it six times and users could not carry a preference from the
browser to the desktop app or the TV.

## Decision

1. **One token source, OKLCH.** `packages/design-tokens/src/tokens.ts` declares colour roles,
   radii, motion, breakpoints and safe-area variables once. Every colour role is an OKLCH triple
   whose hue is `var(--accent-h)`; lightness/chroma are fixed per mode so any accent — preset,
   custom hue or sampled from cover art — stays ≥ 4.5:1 by construction. Neutrals carry a faint
   indigo bias; dark text is warm ivory. Brand colours (`--brand`, `--brand-2`, `--brand-accent`,
   deck A–D) are the only ones never re-hued.
2. **Seven theme dimensions, not named themes.** `data-mode`, `data-accent`, `data-surface`,
   `data-density`, `data-radius`, `data-motion` and `lang` are independent attributes on
   `<html>` (plus `data-tv` and `data-standalone` as environment flags). MixAI DJ skins become
   `surface` presets (`flat-pro`→`flat`, `studio-metal`→`solid`, `minimal`→`reduced` motion);
   its green survives as the `emerald` accent.
3. **One persisted blob: `localStorage["mixai:prefs:v1"]`** = `ThemePrefs { mode, accent,
   surface, density, radius, motion, locale, feedback }`. Legacy keys `theme`, `mixai-ui` and the
   `mmo-locale` cookie are read once when the blob is absent. The web `PreferencesSync` syncs
   the `mixai:`/`mmo:` prefixes to the profile so the choice follows the account.
4. **No flash: `prehydrate.js`.** A generated 1 KB ES2017 script runs in `<head>` on every
   web-based surface and writes the attributes (and `--accent-h`) before first paint. React's
   `ThemeProvider` (in `@mmo/ui`) then hydrates from the same blob.
5. **Base UI, not Radix.** `packages/ui` is built on `@base-ui/react` 1.8 (shadcn's default since
   2026-07): `render` prop instead of `asChild`, Floating UI positioning, `data-open`/`data-checked`
   state attributes. Web's `components/ui/*` are thin wrappers (`withAsChild` HOC, `NativeSelect`
   for `<option>` callers) so the 23 call-site families migrated mechanically. Motion uses
   `motion` 13 presets and React 19.3 `<ViewTransition>` for routes.
6. **Generated artefacts per platform.** `pnpm tokens:build` emits `tokens.css` (Tailwind v4
   `@theme inline`, variants `dark/glass/solid/flat/compact/tv/standalone/ultrawide`, utilities
   `surface`, `pb-safe`, `overscan`…), `tokens.plain.css` (vanilla pages: Tizen, extension,
   native shell), `Tokens.kt` (Compose `object Tokens`), `prehydrate.js` and `tokens.json`. Tizen
   gets an `@supports not (color: oklch(0 0 0))` sRGB block because its Chromium predates OKLCH;
   the extension scopes the variables on `#mixai-download-btn` instead of the host `:root`.
7. **Consumption by tsconfig `paths`** (`@mmo/ui`, `@mmo/design-tokens`), keeping the repo's
   per-app lockfiles. Each app dedupes `react`, `react-dom`, `motion`, `@base-ui/react` to its own
   `node_modules`.

## Consequences

- **Positive.** One place to change a colour or a radius; a user's accent/surface/density follows
  them from web → Companion → MixAI DJ → TV; light mode exists everywhere and does not flash;
  accessibility is a property of the token maths, not per-screen QA; new surfaces bootstrap in
  five steps (`design-system.md` §9); `/dev/ui` catalogues every primitive.
- **Costs.** Every Vite/Next app needs the React dedupe or hooks crash with `Cannot read
  properties of null (reading 'useState')`; `packages/*` sources must not use `.ts` import
  extensions (web tsc lacks `allowImportingTsExtensions`); `Tokens.kt` and the Tizen sRGB block
  are generated copies that must be re-run on token changes (CI diff-checks web); Base UI's
  event signatures (`onOpenChange(open, details)`) differ from Radix and bit a few callers.
- **Versioning.** Major bump on every surface (web 2.0.0, Companion 3.0.0, extension 3.0.0,
  MixAI DJ / native / TV 1.0.0) because storage keys, DOM attributes and the primitive API
  changed (D14).
- **Blocked upgrades noted, not hidden.** Web stays on TypeScript 5.9 and ESLint 9
  (`typescript-eslint` has no TS 7 API; `eslint-plugin-react` peers ESLint 9). Other packages
  are on TS 7.

## Alternatives considered

- **Keep shadcn on Radix (`radix-ui` 1.6).** Working, but shadcn moved its default to Base UI and
  Radix's `asChild`/`data-state` API is the one being deprecated in the ecosystem; migrating once
  now avoids a second migration.
- **`next-themes`.** Handles only `mode`, is Next-specific and cannot serve MixAI DJ (Vite),
  Companion (Electron) or the TV apps; a 7-dimension provider that also runs pre-hydration was
  simpler than wrapping it.
- **CSS-in-JS / styled-components / per-app Tailwind configs.** Runtime cost on TV hardware and
  no path to Compose; tokens must exist as data to generate `Tokens.kt` and plain CSS.
- **Separate design systems per surface (status quo).** Rejected — the five palettes and three
  stores were the problem being solved.
- **Named themes ("Neon", "Studio", …).** Rejected in favour of orthogonal dimensions; presets can
  still be expressed as a set of dimension values.
