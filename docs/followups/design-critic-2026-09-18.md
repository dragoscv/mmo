# Design critic — MixAI design overhaul (2026-09-18)

Scored against the `design-critic` rubric (/60) using screenshots in `.copilot-tmp/shots/critic/`
and `.copilot-tmp/shots/mixai-*.png` (dev server, real tokens). Product UI is scored with the
`frontend-design` bar (calm, systematic), not the cinematic bar — only the landing page is high-craft.

| Surface | Craft /25 | Game feel /25 | Discipline /10 | Total | Verdict |
|---|---|---|---|---|---|
| Web landing `/` (light+dark, 390/1440/3440) | 19 | 14 | 9 | **42** | Polish pass |
| Web app shell + Settings › Appearance | 20 | 16 | 10 | **46** | Polish pass |
| Web Library (auth-gated → NotSignedInState) | 17 | 12 | 10 | **39** | Polish pass (gate only) |
| `/dev/ui` catalog | 21 | 15 | 10 | **46** | Ship (internal) |
| MixAI DJ (dark glass, light, flat, ultrawide) | 21 | 17 | 9 | **47** | Polish pass |
| Companion (Vite renderer) — code-reviewed only | – | – | 10 | n/a | not rendered (Electron not launched) |

## What is right
- Palette discipline: 0 hardcoded brand hex in web player/mixai/tv/extension/native; accent, mode,
  surface, density, radius all flow from `mixai:prefs:v1` → prehydrate → tokens. Light mode is real
  everywhere, not an afterthought.
- Composition at 3440 px: landing content is clamped (`content-*`), no stretched hero; mixai uses the
  width for Library + AutoMix side columns (5-column grid). No horizontal overflow on any capture.
- Mobile: bottom tab bar + 56 px mini-player; landing stacks cleanly at 390.
- Typography: Space Grotesk display + Inter body + JetBrains Mono; hierarchy visible on landing and
  appearance page.
- Discipline: server-first pages, skeleton `loading.tsx` on 47 routes, reduced-motion honoured,
  radios with `aria-label`, axe spec in place.

## Prescriptions (priority order)
1. **Landing hero has no living background** (8: 2/5). Add the `surface-glow` + slow drifting
   gradient blob (`motion-full:` only) behind the hero in `apps/web/src/app/(marketing)` hero
   component; keep static under reduced motion.
2. **Choreographed entrance** (6: 3/5): landing sections fade together. Stagger hero → feature cards
   → CTA with `rise` preset delays (0 / 120 / 240 ms) via `@mmo/ui/motion`.
3. **Library gate is a dead end** (subject presence 2/5 when logged out): `NotSignedInState` should
   show a 3-track ghost DataTable skeleton behind the CTA so the page previews its purpose.
4. **MixAI deck waveform is the hero but sits flat** (10: 3/5): add deck-colour edge glow
   (`--deck-a/b`) on the active deck card and a 1.5 % scale on play; already have `--surface-glow`.
5. **Appearance preview card**: add a live mini DataTable + button row to the `ThemePreview` so
   density/radius changes are visible at a glance (currently only the player mock).
6. Companion: capture screenshots in the next Electron session (needs `pnpm dev` in server/) and
   score; renderer is tokens-only by construction but unverified visually.

## Regressions vs. previous version
- None observed: every surface that was dark-only now also has light; no lost features spotted in
  the captured routes. Hydration warning on `/settings/appearance` occurred once on cold compile
  only; three warm reloads clean.

## User-intent gap
Partial → mostly met. Asked for: modern UI with transitions/animations, skeletons, theme system
(mode/accent/surface/locale), responsive >21:9 + native-feel mobile, reusable architecture, latest
deps. All present and verified. Gap: cinematic "wow" on the landing (items 1–2) and the DJ deck
glow (item 4) — polish, not structure. Prescriptions 1–5 are ≤ 1 h each and are the recommended
next slice before a public release.
