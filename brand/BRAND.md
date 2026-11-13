# MixAI brand

Version 1.0.0 (2026-11-12). Owner: Dragos Catalin Vladulescu. Decisions: [ADR-0016](../docs/adr/0016-mixai-tv-name-brand-and-experience.md),
tracker §15 (WP22-03..10). Machine-readable summary: [`brand.json`](brand.json).

Everything visual in this folder is **generated**. The sources are four files in [`src/`](src) plus the product
colours in `packages/design-tokens`. Never draw, export or recolour a logo by hand: change the source and run the
generator ([How to change something](#how-to-change-something)).

## Platform

**Purpose.** People own films, series and music. MixAI lets them play what they own, from their own server, on
every screen they have, without renting it back from anyone.

**Positioning.**

| | |
|---|---|
| RO | Media ta, de pe serverul tău, pe orice ecran. |
| EN | Your media, from your own server, on every screen. |

For people who keep their own library and want one family of apps for it. Against rented catalogues and against
media servers that look like admin panels.

**Personality** (this, not that):

| This | Not that |
|---|---|
| Cinematic | Loud |
| Yours | Rented |
| Precise | Cold |
| Playful in motion | Playful in words |
| One system | A collection of apps |

**The mark in one sentence.** Many sources, one signal: the lines are the sources, the dot is the signal
(RO: „Multe surse, un singur semnal”).

## Voice

Principles, both languages:

1. Say what happened and what to do next. One idea per sentence.
2. Romanian addresses the person as „tu”. No „dumneavoastră”, no plural „voi” for one person.
3. No exclamation marks. No jokes in text; the motion carries the play.
4. Name things by what the person sees: „bibliotecă”, „server”, „televizor”. Technical names stay in settings
   and logs.
5. Never blame the person. Never say „simplu” / "simply" / "just".

Tone per context:

| Context | RO | EN |
|---|---|---|
| First run | Conectează-te la serverul tău. Durează un minut. | Connect to your server. It takes a minute. |
| Empty state | Biblioteca e goală. Adaugă un folder în MixAI Server. | Your library is empty. Add a folder in MixAI Server. |
| Loading | Se pornește… | Starting… |
| Success | Gata. Televizorul e conectat. | Done. The TV is connected. |
| Error | Nu am găsit serverul. Verifică dacă e pornit și încearcă din nou. | Server not found. Check that it is running and try again. |
| Destructive action | Ștergi profilul „Ana”? Istoricul lui dispare. | Delete the profile "Ana"? Its history goes with it. |
| Store listing | Filmele, serialele și muzica ta, de pe serverul tău. | Your films, series and music, from your own server. |
| Release notes | Căutarea ține cont de limita de vârstă a profilului. | Search respects the profile's age limit. |

## Names

- The family is **MixAI** (capital M, capital A, capital I, no space, no hyphen).
- A product is always **MixAI + product**: MixAI TV, MixAI Music, MixAI Decks, MixAI Live, MixAI Studio,
  MixAI Key & BPM, MixAI Server, MixAI Connector. The same name in every language.
- The short form (TV, Music, Key & BPM…) is allowed only under an icon where the full name does not fit
  (launcher label on a watch, a tile caption). Never in a sentence.
- **MixAI Server** is the name people see. "MMO Server" is the technical name and stays in the repository,
  the API title, Docker image names and the network service type. "MixAI Companion" is retired; it survives only in
  identifiers that must not change (app id `ro.mixai.companion`, the data folder, the Windows program file).
- A product name takes no article: "Open MixAI Server", not "Open the MixAI Server".
- Never: MixAi, Mix AI, Mixai, MIXAI, MMO as a product name, "MixAI downloader", "MixAI DJ".

Third-party use of the names and icons: [`TRADEMARKS.md`](../TRADEMARKS.md).

## The mark

Source: [`src/marks.mjs`](src/marks.mjs). Sheet with every number: [`dist/logo/construction.svg`](dist/logo/construction.svg).

- **Family mark:** the letter M made of two streams that stop short of one dot. Left stream = stream A, right
  stream = stream B, dot = the signal.
- **Grid:** 48 units, live area 36 units (6 unit margin). One stroke width per drawing, round caps and joins.
  Family mark stroke 6 units, product glyphs 5 units. The dot is a true circle; in the family mark its diameter
  is 1.5 strokes.
- **Optical sizes:**

  | Rendered size | Drawing |
  |---|---|
  | 16 px and below | `micro`: its own drawing on a 16 grid, stroke 2 px, centre lines on whole pixels |
  | 17 to 40 px | `master` geometry, stroke × 1.12, dot × 1.06 |
  | above 40 px | `master` |

- **Clear space:** 12 units (a quarter of the mark's box) on every side.
- **Minimum size:** 16 px for the symbol. Lockup: 20 px high; below that use the symbol alone.
- The mark must work flat, in one colour, with no gradient, glow or shadow.

### The family

One grammar for every product: lines + exactly one dot, one colour.

| Product | Glyph | The dot is |
|---|---|---|
| MixAI TV | a screen on a stand | what plays |
| MixAI Music | a note | the note head |
| MixAI Decks | a platter | the spindle |
| MixAI Live | a voice going out both ways | the voice |
| MixAI Studio | three channel faders | the fader that is set |
| MixAI Key & BPM | a metronome | the weight on the arm |
| MixAI Server | one box that serves | the light that says it is on |
| MixAI Connector | a plug | the contact |

The family mark stays on the suite, the site, the wordmark and anything that speaks for all products. A product
uses its glyph everywhere it appears alone: icon, start screen, tray, product page. That includes MixAI Server,
which has its own glyph and colour (owner, 2026-11-12; the comparison sheet's caption said the server and the
start screens would keep the family mark, and that was dropped: a start screen shows the icon that was pressed,
and Android requires it).

### Wordmark and lockups

- Lettering is **outlined Space Grotesk** (700 for "MixAI", 500 for the product name), stored as paths in
  [`src/lettering.json`](src/lettering.json). No live text in a logo file.
- The dot of the "i" is replaced by the signal: a true circle, wider than the stem.
- "Mix" and the product name take the text colour; "AI" takes the accent: stream B for the family, the product
  colour for a product.
- Lockup = symbol + lettering on one line: cap height 24 units, baseline at 36, gap 12 units from the symbol box.

### App icon

- **Dark tile, coloured mark, ivory signal**, in every theme. Tile colour `--mark-tile`.
- Corner radius 22.5 % of the side where the platform does not mask. Symbol scale: 80 % above 32 px, 87.5 % from
  17 to 32 px, 100 % at 16 px.
- Android: adaptive foreground inside the 66 dp safe circle, plus the **monochrome** layer for themed icons.
  iOS: default, dark and tinted variants. macOS: the system rounded body drawn in. Maskable web icons are
  separate files, never `"any maskable"`.
- Inside an interface the same icon is `<BrandMark product tile>`. It is flat: no glow, no shadow, no tinted
  plate of another colour behind it. Light belongs to the scene around an icon, never to the icon.

## Colour

Source: `PRODUCTS` and `MARK` in `packages/design-tokens/src/tokens.ts`. Authored in OKLCH, shipped with sRGB
fallbacks. CSS: `--product-<id>`, `--mark-a`, `--mark-b`, `--mark-signal`, `--mark-tile`.

| Product | Dark surfaces (OKLCH) | sRGB | Light surfaces (OKLCH) | sRGB |
|---|---|---|---|---|
| MixAI TV | 0.70 0.19 290 | `#9f88ff` | 0.50 0.21 290 | `#683ecf` |
| MixAI Music | 0.72 0.20 345 | `#f767c1` | 0.52 0.20 345 | `#b12083` |
| MixAI Decks | 0.80 0.13 215 | `#37d2f2` | 0.50 0.11 215 | `#006f83` |
| MixAI Live | 0.76 0.17 50 | `#ff8f4b` | 0.53 0.15 50 | `#a94e00` |
| MixAI Studio | 0.86 0.16 95 | `#f2cf3b` | 0.50 0.11 95 | `#766200` |
| MixAI Key & BPM | 0.80 0.19 145 | `#61dc6b` | 0.50 0.15 145 | `#107823` |
| MixAI Server | 0.68 0.16 255 | `#4c99f8` | 0.50 0.18 255 | `#0061be` |
| MixAI Connector | 0.80 0.13 180 | `#40d9c1` | 0.50 0.10 180 | `#007465` |

Family mark: stream A = the TV colour, stream B = the Music colour. Signal: ivory `#f5f1ea` on dark, ink
`#0c0c16` on light (the theme's foreground). Tile `#11101a`, splash canvas `#07060f`.

Rules:

- **The product colour is identity, not interface.** It belongs to the icon, the splash, the wordmark, the product
  page and the product's badge in the suite. The accent of the interface stays the person's choice.
- No red in the family: red means error.
- Use a product colour for glyphs, large text and accents. Do not set running text in it on dark surfaces
  (it passes WCAG, but APCA flags it as hard to read at body sizes).
- Marks, icons and wordmarks: flat colour, no gradient, no glow. The headline gradient of the interface
  (`--brand-gradient`, violet to magenta = stream A to stream B) is a design-system token for display text on
  family pages (the suite); a product page sets its title in the text colour next to the product mark.

**Proof.** [`contrast-pairs.json`](contrast-pairs.json) is generated from the tokens: every pairing of a product
colour or the signal with the surfaces it sits on, in both themes. Result on 2026-11-12
(`node brand/scripts/contrast-gate.mjs brand/contrast-pairs.json`): 87 pairs, **0 WCAG 2.2 AA failures**, lowest
ratio 5.41:1 (MixAI Live on the light background), 14 APCA advisories, all of them "product colour as running
text" on dark surfaces (see the rule above).

## Type

Space Grotesk (display), Inter (interface), JetBrains Mono (code). All OFL-1.1; licence texts next to the font
files in `apps/web/src/app/fonts`. Romanian coverage (ă â î ș ț with comma below, both cases) checked on all 11
shipped font files on 2026-11-12 with `brand/scripts/check-glyphs.py`: all pass.

## Motion

Source: [`src/motion.mjs`](src/motion.mjs). One definition generates CSS keyframes, animated SVG, Android
`AnimatedVectorDrawable`, Compose and SwiftUI code. No runtime player. Demo: [`dist/motion/demo.html`](dist/motion/demo.html).

Every animation starts and ends on the static mark, so an interrupted animation never leaves a broken logo.

| Animation | Time | Meaning | Reduced motion |
|---|---|---|---|
| `intro` | 900 ms (990 with the line stagger) | Launch. The sources flow into the signal and come back out. | static mark |
| `loading` | 1400 ms, loops | Working. The signal breathes, the sources dim in turn. | static mark, with a text status next to it |
| `success` | 320 ms | Done. One beat of the signal. | static mark |
| `error` | 180 ms | Failed. A short sideways shake: shape, not colour. | static mark |
| `press` | 140 ms | Pressed. The mark compresses to 94 %. | opacity 0.8 instead of scale |
| `morph` | 420 ms | Splash to first screen. The sources fade, the signal grows over the screen. | cross-fade 150 ms |

Rules:

- `loading` never appears without a text status („Se pornește…”). Under reduced motion the text is the only cue.
- The Android system splash plays `intro` (the platform allows 1000 ms). Android TV and Apple launch screens are
  static by platform rule; the intro plays in the first screen of the app.
- Reduced motion follows the system setting and the app's own `data-motion="reduced"` switch, for all six
  animations (`press` included).

## Sound

Source: [`src/sonic.mjs`](src/sonic.mjs), variant "Two, then one": one note left, one note right, then a single
note in the middle. 1.4 s, peak −6 dBFS, synthesised (no samples, no third-party material).

- Plays once at start on the **TV apps** (Android TV, Apple TV, Tizen / webOS, MixAI TV for desktop), with a
  setting „Sunet la pornire” / "Startup sound" to turn it off. Off by design on phones and watches.
- Never over other audio, never louder than programme audio, never on resume.

## Misuse

Do not:

- redraw, stretch, rotate, outline or add effects to a mark;
- change a product colour, or put a mark on a busy photo without the tile;
- type the wordmark in a font (use the outlined lockup);
- use the family mark as the icon of one product, or a product glyph for the suite;
- write a product name without "MixAI", or translate it;
- animate the mark in any way other than the six animations above;
- commit an icon that the generator did not write (the drift gate rejects it).

## Using the brand in code

| Platform | Use |
|---|---|
| React (`@mmo/ui`) | `<BrandMark product="tv" size={32} animation="loading" />`, `<BrandLockup product="tv" height={32} />`; CSS ships in `@mmo/ui/styles.css` |
| Plain HTML boot screens | regions `<!-- brand:style:start -->`, `<!-- brand:logo:start -->`, `<!-- brand:wordmark:start -->` (and the matching `:end`); the generator owns what is between the markers |
| Android Compose | `BrandMark(product = BrandProduct.Tv, animation = BrandAnimation.Intro)` from the generated `Brand.kt`; resources `@drawable/avd_brand_intro`, `@color/brand_*`, `@integer/brand_intro_ms` |
| SwiftUI | `BrandMarkView(.tv, animation: .intro)` from `MixaiCore` (`Brand.swift`) |
| Anything else | files under [`dist/`](dist): SVG masters, PNG, animated SVG, `tokens.json` |

## How to change something

1. Edit the source: a shape in `src/marks.mjs`, a timing in `src/motion.mjs`, the sound in `src/sonic.mjs`, a
   colour in `packages/design-tokens/src/tokens.ts` (then `pnpm tokens:build` at the repository root). A new
   product name also needs its outlined run: add it to `scripts/outline-lettering.py` and run it.
2. `node brand/scripts/build.mjs` writes every output that changed (`--list` shows all of them and their groups,
   `--only=web,android` limits the run).
3. `node --test brand/scripts/build.test.mjs` and `node brand/scripts/contrast-gate.mjs brand/contrast-pairs.json`.
4. Commit the source **and** the outputs together. The drift gate (`node brand/scripts/build.mjs --check`, wired
   into lint-staged and CI) fails when a committed output differs from the source: text files are compared byte
   for byte, rasters through `dist/manifest.json` (hash of the drawing and of the file).
5. Bump `version` in `brand.json` and add a line to the changelog below: major = a mark or a product colour
   changes, minor = a new asset or product, patch = a fix.

## Where it is used

Every surface in [`docs/arhitectura/app-inventory.md`](../docs/arhitectura/app-inventory.md) takes its marks from
the generator. Build and device verification per surface is recorded in the tracker (§15, WP22-10).

| Surface | What it takes |
|---|---|
| Web (`apps/web`) | favicon, PWA icons and manifest per host, apple-touch icons, OG images, `BrandMark` / `BrandLockup` in the interface |
| Android TV, phone, Music, Key & BPM, Live, Decks (+ Wear OS modules) | adaptive + monochrome launcher icons, TV banner, splash intro, notification icon, `Brand.kt` |
| MixAI Studio Android shell (`apps/native/android`) | launcher icons, splash images, banner |
| iPhone, Apple TV, Apple Watch, MixAI Music, Key & BPM, Decks, Live (`apps/ios`) | app icon sets (default, dark, tinted; layered tvOS icon and Top Shelf), `Brand.swift` |
| Desktop shells: Decks, Studio, Music, TV, Live (Tauri) | icon sets incl. MSIX logos, boot screen with the logo motion |
| Decks for desktop (Compose) | `.ico`, `.icns`, `.png` |
| Samsung Tizen + LG webOS (`apps/tv-tizen`) | app icons, boot screen, startup sound |
| MixAI Connector (`apps/extension`) | toolbar and store icons |
| MixAI Server (`server`) | app icon, tray icons (colour tile; template image on macOS), splash with the logo motion |
| Store listings | `apps/<app>/store/graphics/` and `dist/store/<id>/` (upload is a separate step, approved per store) |

The marks used before 1.0.0 are kept in [`archive/2026-11-12/`](archive/2026-11-12/README.md). Nothing there is
used by a build.

## Directions that were rejected

So nobody proposes them again without new facts (owner gates B, C and E, 2026-11-12):

- **Mark:** twin arches (reads as another well-known brand's arches), parallel bands (no M, looks like a merge
  icon or a plug), junction (the idea of merging is lost).
- **Family:** the same mark in eight colours (identical icons in themed and tinted modes, collisions for people
  with colour-vision deficiency); the mark with a small product badge (the badge is 8 px at 24 px).
- **Colour:** today's interface presets as product colours (Live landed on error red); muted pastels; a
  one-colour family mark; the product colour as the default interface accent.
- **Sound:** two tones sliding into one; a slow swell.
- Banned for good in the **family mark**: play triangle, chevron, disc, bars, sparkle, orb. They say "a media
  app", not "MixAI". A product glyph may picture the product's own tool (the Decks platter, the Studio faders),
  in the family grammar: lines and one dot. Banned everywhere: the violet-to-blue gradient.

## Changelog

### 1.0.0 (2026-11-12)

- New mark "Punct de mix" and the family of eight product glyphs; outlined wordmark and lockups.
- Product colours as design tokens, contrast-proven; family mark in two colours.
- One generator for every icon, splash, store graphic and code module, with a drift gate.
- Logo motion set (intro, loading, success, error, press, morph) and the sonic signature.
- Names: MixAI Server (was MixAI Companion), MixAI Connector (was MixAI downloader), MixAI Key & BPM in every
  language.
- The five marks used before are archived under `archive/2026-11-12/`.
