# WP22-10 design-critic review: brand pack on the comparison sheet and three real surfaces

Date: 2026-11-12 / 13. Rubric: the `design-critic` skill (12 criteria, 5 points each, 60 total). Target for a full
page: 52 or more, the same as WP16 and WP17. Brief: [`brand/BRAND.md`](../../brand/BRAND.md), ADR-0016 items 3 to 7,
and the scene brief of the suite landing in [`wp17-suite.md`](wp17-suite.md).

**Result: the suite landing reaches the target (52/60). The Decks landing does not (39/60).**

| Surface | First pass | Second pass | Third pass | Verdict |
|---|---|---|---|---|
| Suite landing `mixai.ro/` (signed out) | 49/60 | 51/60 | **52/60** | at the target, ship band |
| MixAI Decks landing `decks.mixai.ro/` | 36/60 | **39/60** | not re-scored | polish pass needed; the page shows no product |
| MixAI Server start screen | 39 of 50 | **40 of 50** applicable points | not re-scored | 80 % |
| Comparison sheet (decision document) | 24 of 30 | not re-scored (a record of gate B) | | 80 % |

The scores are from an independent reviewer (a separate agent, read-only, told that the target must not influence
the numbers), not from the author of the changes. One change to the suite landing was made after the third pass
and is **not scored**: see "After the third pass".

## How the evidence was gathered

| | |
|---|---|
| Build | `apps/web` production build (`next build`, Turbopack) of the working tree, served by `next start` on this machine with an unreachable database address and throwaway auth values. Two small proxies add the host header the app routes on (`mixai.ro`, `decks.mixai.ro`). **Not the live hosts**: live `mixai.ro` does not serve the suite landing yet |
| Screenshots | headless Chromium at 1440 x 900 and 390 x 844, dark and light, plus reduced motion, plus the product section with the first card hovered and focused. Local scratch (`.copilot-tmp/tv-brand/sheet/critic2/`), not committed |
| Real browser | the suite landing and the Decks page were also opened in a GPU browser. The first review flagged rectangles around the orbit tiles as "unverified"; in the GPU browser there were none (a software-rendering artefact of a glow that is now removed) |
| Measured | running animations in normal and reduced motion, axe (WCAG 2.0 to 2.2 AA, serious and critical) inside `main`, heading face, one sentence per title line, horizontal overflow, hover transform, focus outline, colours of the core and the tiles; start screen: opacity sampled during the exit in three motion modes |
| Code read | `apps/web/src/components/suite/{suite.css,orbit.tsx,suite-landing.tsx,products.ts}`, `apps/web/src/app/dj/page.tsx`, `server/ui/index.html`, `packages/ui/src/brand/{brand-mark.tsx,generated/logo.css}` |
| Limits | stills cannot show motion: every motion criterion is scored from code and measurements. The floating "Maestro" button of the web app is in every shot; it is not part of this work |

Labels: **E** = seen in a screenshot, **C** = read in code, **M** = measured.

## Suite landing — 52/60

Third pass, one criterion moved: **palette 4 → 5**. The core's highlight is now lighter than its body in both themes
and keeps the Server hue. Measured on the rendered core: dark L 0.760 / 0.680 / 0.453 (highlight / body / edge),
light L 0.640 / 0.504 / 0.449, hue 255 to 257 throughout. **Living background stayed at 4**: the two washes now
drift against each other (+49 / +22 px and −27 / −12 px in 10 s), but on a gradient this soft that is a tint shift
of a few levels, not visible motion; the reviewer's words: "a moving soft wash alone does not earn a 5". The table
below is the second pass; apart from criterion 4 the third pass gave the same numbers.

```
SCORES (after the fixes)
  Craft (25):     21/25
    1. Subject presence   4/5  E    — Server core + orbit reads at once; modest scale (core about 155 px at 1440)
    2. Composition        4/5  E    — the bottom 235 px of the 1440 x 900 viewport is empty; the next heading starts just below the fold
    3. Three layers       4/5  E+C  — the wash is now behind every section and planets pass behind the core; the product section still has no midground
    4. Palette discipline 4/5  E+C  — the core now carries the Server colour, but its highlight came out teal in dark and as a dark blotch in light
    5. Typography         5/5  E+M  — one sentence per line at 390 and at 1440; display, body and mono voices are clear
  Game feel (25): 20/25
    6. Choreographed entrance 4/5  C+M — cards below the fold now enter when scrolled into view; the hero is still two overlapping beats
    7. Tactile interactions   4/5  E+M — the hover lift works (−3 px), hue-true border, 2 px focus ring, press on the logo; the orbit ignores the pointer
    8. Living background      4/5  C+M — the wash drifts, but about 2 px/s on a soft gradient is too slow to register; stars are static
    9. Route morphing         4/5  C   — launcher tile FLIP only; landing to a product host is a full navigation
    10. Subject artistry      4/5  E   — the real app icons, flat, in correct depth order; the large TV mark on the tall card; still no product imagery
  Discipline (10): 10/10
    11. Server-first shell    5/5  C   — async server component, orbit in pure CSS
    12. A11y + reduced motion 5/5  E+M — axe [], 0 animations with reduced motion, card focus ring, links named per product
TOTAL: 51/60
```

What moved against the first review (49): typography 4 → 5 (the title no longer breaks mid-sentence on a phone),
subject artistry 3 → 4 (app icons instead of hand-made tinted tiles with a glow). Four fixes were real but earned no
point: the Server colour on the core (a new fault in the same element), the scroll-driven entrance, the working hover
lift, the drifting wash.

Measured on the build that was scored: 13 running animations, 0 with reduced motion; axe `[]` in dark and in light;
no horizontal overflow at 390 and 1440; core background equals `--product-server` in each theme; tile fill
`rgb(17, 16, 26)` with no shadow; first card `transform: none` at rest and `translateY(-3px)` on hover; its link is
named "Află mai multe MixAI TV" through `aria-labelledby`.

The reviewer made criterion 10 conditional on the orbit rings being whole in a GPU browser (in the headless stills
the outer ring looked fragmentary). Measured there with the animations paused: the rings are visible in 62 of 72
angular sectors as built and in 65 of 72 with the 3D sorting turned off, so the shared 3D space is not what hides
them; the gaps are where the core and the icons cover the line. The 4 stands.

## MixAI Decks landing — 39/60

```
  Craft (25):     16/25   1. Subject 2 · 2. Composition 3 · 3. Layers 3 · 4. Palette 4 · 5. Typography 4
  Game feel (25): 13/25   6. Entrance 4 · 7. Tactile 3 · 8. Living background 2 · 9. Morph 2 · 10. Artistry 2
  Discipline (10): 10/10  11. Shell 5 · 12. A11y + reduced motion 5
TOTAL: 39/60 — polish pass needed
```

The page is correct and generic: a 72 px mark, the product name and three text cards. Nothing shows the product.
Against the first review (36): the lower wash is the Decks colour instead of the Music colour, the mark plays its
intro without the page's blur over it, and the background is no longer still.

**Owner decision, 2026-11-12:** small fixes now; a picture of the app is a separate item (tracker WP22-17), after
the Decks interface that is being reworked settles. The page stays below the target until then.

## MixAI Server start screen — 40 of 50

```
  1. Subject 5 · 2. Composition 4 · 3. Layers 3 · 4. Palette 5 · 5. Typography 4 · 6. Entrance 3
  8. Living background 4 · 9. Exit 3 · 10. Artistry 4 · 12. A11y + reduced motion 5      (7 and 11: n/a)
TOTAL: 40 of 50 applicable points
```

Fixed after the first review: under reduced motion the screen cut to the first view with no transition (the rule
forced `opacity: 1` on the splash, so `.hide` could not fade). Measured now: it fades over 200 ms without the zoom,
with the system setting and with the app's own switch. The status line is 14 px.

Open: the mark starts in `loading` with no `intro`, and the exit is a plain fade, not the `morph` the brand book
defines for this step. The owner moved the morph to phase 2 (tracker WP22-08).

## Comparison sheet — 24 of 30

Scored once as a decision document (criteria that do not apply to a document are left out). It did its job at gate
B. Its faults: the S1 and context panels still show MixAI Live in red, which the colour decision taken afterwards
forbids; captions and the contrast table are 9 to 10 px; the caption of S1 said the family mark would stay on the
server and the start screens, while the sheet itself drew a Server glyph. The owner settled that on 2026-11-12: every
product, MixAI Server included, starts with its own glyph (`brand/BRAND.md`, "The family").

## After the third pass

The third pass raised two observations. Both were checked on the build before anything was changed.

| Observation | Checked | Result |
|---|---|---|
| "The Server mark is missing from the core under reduced motion" (in one still) | reduced motion, no script touching the mark: `visibility: visible`, `opacity: 1`, 57 x 57 px, stroke painted | not a defect of the page; the still was taken by a script that hid the mark to sample the core's colour and re-showed it one frame too late |
| "In the frozen frame MixAI TV is behind the core and MixAI Music is on top of it" | positions measured: both overlap the core, in reduced motion (the permanent picture) and in the first frame for everyone | real. **Changed, not scored:** new start angles in `orbit.tsx`. Measured on the rebuilt page, in reduced motion and in the first frame: no icon overlaps the core and no two icons overlap each other (a first attempt cleared the core but put MixAI TV on top of MixAI Studio; the angles were chosen again). The breathing animation also dropped the sphere's lower shade at its mid-point; it keeps it now |

Decks: text cards no longer react to hover at all (measured: transform and glow identical at rest and on hover).

## What is left, in priority order

1. **Product imagery** on the Decks page and in the suite's tall first card (WP22-17). It is the largest single
   gain: Decks subject, composition, layers and artistry all wait on it.
2. **Living background on the suite** (4): something with an edge has to travel, not only a soft wash: a smaller
  second radial per layer, and the stars moved to a page-level layer in two depths with a slow twinkle.
3. **Orbit geometry**: both rings lie in the same plane (the tilt only shifts the icons' phase); inclining them
  differently would add depth. Faint banding shows in the soft washes in headless stills; check on a real display.
4. **Hero entrance on the suite**: play the Server mark's `intro` once on the core, then the planets, then the copy
   (entrance 4 → 5).
5. **Empty lower quarter of the first viewport** on the suite at 1440 x 900 (composition 4 → 5): less top padding,
   or a row of product lockups under the hero.
6. **Server start screen**: `intro` before `loading` (needs a generator change, and the minimum time on screen is
   shorter than the intro), then the redesigned `morph` (phase 2).
7. **Decks**: a larger mark (120 to 144 px) until the picture exists.
8. Second container for product icons: the cards use a mark on a tinted chip, the orbit uses the tile from the brand
   book. Same colour, two shapes.
9. Keyboard focus on a card gets the lift, the border and the ring, but not the stronger glow that hover gets.
10. Outside the brand work: the Maestro button sits on the orbit at 390 px and on the third Decks card.
