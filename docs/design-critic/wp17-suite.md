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
