# WP17-12 — mixai.ro suite landing + launcher: scene brief and critic checklist

Tracker: [§12 WP17-12](../mixai-design-tracker.md). Code: `apps/web/src/components/suite/*`, `apps/web/src/app/page.tsx`
(suite host), `apps/web/src/app/dj/page.tsx`.

## Scene brief

```
SCENE: mixai.ro/ (signed out)
SUBJECT      — the visitor's own MixAI Server as a breathing, luminous core; TV, Music, Studio and DJ orbit it
COMPOSITION  — copy left (golden ratio 0.382), orbit right at ~0.618; stacks on mobile (copy first); max 1440 px
PALETTE      — dominant: --primary (accent hue from theme prefs) · per product: --chart-1..5 · ambient: --background
LIGHTING     — core glow = primary at 55 % / 30 % spread; planets carry their accent as rim glow
ATMOSPHERE   — two radial washes (primary top-right, music accent bottom-left) + a sparse star field
TYPOGRAPHY   — Space Grotesk 650 display (clamp 2.4–5 rem, -0.035 em), Inter body, JetBrains Mono eyebrows
CHOREOGRAPHY — [0] washes · [0–900 ms] orbit fades/scales in · [250 ms+90 ms·i] eyebrow, title, subtitle, CTAs rise
INTERACTION  — product cards lift + accent glow on hover/focus; whole card is the link; chip for your device glows
TRANSITION   — launcher tile → FLIP morph (inset + radius, 420 ms) into the product host
ACCESSIBILITY — prefers-reduced-motion / data-motion=reduced freeze every animation; orbit is role=img with a label;
                all icons aria-hidden; focus-visible outlines in the product accent
```

```
SCENE: mixai.ro/ (signed in) — launcher
SUBJECT      — five product tiles, last used first ("Last used" badge)
STATES       — continue strip: loading (skeletons), ok (stills + progress), empty, error, no server (CTA to /get)
EXTRAS       — "Always open X" switch → cancellable 1.6 s forward toast on the next visit
```

## Critic checklist (target ≥ 52, same rubric as wp16-web.md)

- Light + dark, every accent and surface mode (`data-accent`, `data-surface`) — colours are tokens only (hex gate OK).
- 390 / 1280 / 1920 / 3440 px: no horizontal scroll; orbit ≤ 560 px; product grid 1 → auto-fit → 1.4fr/1fr/1fr.
- RO + EN copy complete (`mx.suite`, i18n-parity OK); diacritics render in Space Grotesk.
- Reduced motion: zero running animations.
- Keyboard: Tab order top bar → CTAs → cards → chips → footer; launcher tiles reachable and activate with Enter.

## Run 2026-11-06 — live `mixai.ro` (rev `mixai-web-00014-k72`, web 3.2.1)

Evidence: cloud run `2611061357-z0qo` (`pnpm e2e:cloud --target https://mixai.ro --prod-session e2e/suite-wp17.spec.ts`),
**19/19 passed**: landing at 390 / 1280 / 1920 / 3440 × light + dark with no horizontal overflow and no page error;
launcher at 390 / 1920 × both modes; `tv.` / `music.` / `app.` / `dj.mixai.ro` signed in with the `.mixai.ro`
product cookie (and `/api/auth/session` carries no session token); legacy `/media`, `/media/music`, `/library`, `/dj`
answer 308 to their product host. axe (wcag serious/critical) in `main`: `[]`. Reduced motion: 0 running animations.
Heading face check: `#sx-title` computes `spaceGrotesk`; loaded faces `inter, spaceGrotesk, jetbrainsMono`; RO diacritics
("tău", "ține", "mașină") render in the display face. Tab order reaches the top bar, the CTAs, every product card, the
per-platform matrix and the demo link. Screenshots: `test-results/suite-wp17/*` in the run's results.tgz.

```
SCORES
    Craft (25):     22/25
        1. Subject presence   4/5  E   — the luminous server core with orbiting product planets reads at once in both modes; at 390 it drops below the fold (copy first, by design)
        2. Composition        5/5  E   — copy at ~0.382, orbit at ~0.618, 1440 px max, generous air; 390 stacks cleanly; 3440 stays centred, no stretched lines
        3. Three layers       4/5  E   — radial washes + star field (background), orbit (mid), copy and CTAs (front); the product section below the fold is flatter
        4. Palette discipline 5/5  E+C — tokens only (hex gate 0), violet primary + per-product chart accents; light mode keeps AA on the gradient title
        5. Typography         4/5  E+C — Space Grotesk display with gradient + Inter body + JetBrains Mono eyebrow; the gradient title wraps on three lines at 1920 (a wider measure would read in two)
    Game feel (25): 19/25
        6. Choreographed entrance 4/5  C   — washes → orbit (0–900 ms) → staggered eyebrow/title/subtitle/CTAs (250 ms + 90 ms·i); reduced motion freezes all
        7. Tactile interactions   4/5  C   — cards lift + accent glow on hover/focus, whole card is the link, platform chip for your OS glows
        8. Living background      4/5  C   — the core breathes and planets orbit continuously; washes are static
        9. Route morphing         4/5  C   — launcher tile → FLIP morph (inset + radius, 420 ms) into the product host; landing → product is a full navigation (different origin)
        10. Subject artistry      3/5  E   — orbit glyphs are icons; no product imagery (TV stills, album art) yet on the landing
    Discipline (10): 10/10
        11. Server-first shell    5/5  C   — server page decides landing vs launcher from the session; launcher continue strip loads client-side with loading / empty / error / no-server states
        12. A11y + reduced motion 5/5  E+C — axe 0 serious/critical, orbit role=img with a label, focus-visible in product accent, 0 animations with reduced motion
    TOTAL: 51/60
```

**Result: 51/60, one short of 52.** Fix in web 3.2.2: the hero columns move to the golden ratio from the brief
(1.382fr : 1fr) and the display size to `clamp(2.4rem, 5.4vw, 4.5rem)`, so the title reads in two lines on desktop
(criterion 5). The spec now asserts at most two lines at ≥ 1280 px. Still open, not blocking: product imagery in the
orbit / product cards (10) and depth on the product section (3).
