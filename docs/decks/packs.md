# `.mixaipack` — skins, layouts and controller packs for MixAI Decks

A pack is **declarative data only**: JSON, raster images and woff2 fonts. No JavaScript, no
CSS, no SVG. Every pack is validated and (when signed) verified in Rust
(`apps/mixai/src-tauri/src/pack.rs`) before the UI sees it; the UI then validates layout JSON a
second time. TS contract: `apps/mixai/src/bridge/packs.ts`.

State described: Decks 1.5.0 (2026-11-11). "1.5" marks what is new in it: manifest `v` 2, the `style`
block, `pack_build` / `pack_export`, the `waves` panel in layouts.

## Archive format

A `.mixaipack` file is a zip (entries `Stored` or `Deflated` only):

| Path | Required | Content |
|---|---|---|
| `manifest.json` | yes | `PackManifest` (below) |
| `tokens.json` | for skins | theme tokens (flat `PackTokens` and/or DTCG `color` group); from manifest `v` 2 also a [`style` block](#style-block-manifest-v-2-decks-15) |
| `layouts/*.json` | no | layout JSON objects, ≤ 64 KB each |
| `presets/*.json` | no | presets, must be valid JSON |
| `assets/*` | no | `.png .jpg .jpeg .webp .avif` images, `.woff2` fonts |
| `signature.json` | no | Ed25519 signature (unsigned packs are allowed, shown as **Unsigned**) |

### `manifest.json`

```json
{
  "v": 1,
  "id": "ro.mixai.skin.neon",
  "name": "Neon",
  "version": "1.0.0",
  "kind": "skin",
  "author": "MixAI",
  "description": "Violet glass skin",
  "pro": false,
  "tokens": "tokens.json",
  "layouts": ["layouts/main.json"],
  "preview": "assets/preview.png",
  "fonts": [{ "family": "Space Grotesk", "file": "assets/space-grotesk.woff2", "weight": 600 }]
}
```

- `v` is `1` or `2` (see [Manifest version](#manifest-version)); unknown fields are rejected.
- `id`: `^[a-z0-9]+(\.[a-z0-9-]+){1,6}$`, ≤ 100 chars. Installing a pack with the same id replaces it.
  Ids starting with `ro.mixai.` and the author `MixAI` are reserved for packs signed with an official key.
- `name` and `author` 1–60 chars, `description` ≤ 500, `version` `MAJOR.MINOR.PATCH`.
- `kind`: `skin` | `layout` | `bundle` | `controller`.
- `pro`: requires Decks Pro; enforced by the UI, Rust only stores.
- Every referenced file must exist in the zip with the right type (tokens/layouts/presets `.json`,
  preview an image, fonts `.woff2`, font weight 100–900, family `^[A-Za-z0-9 \-]{1,40}$`).

### Manifest version

| `v` | Read by | Adds |
|---|---|---|
| `1` | every MixAI Decks version with packs (1.3.0 and newer) | — |
| `2` | MixAI Decks 1.5 and newer | `tokens.json` may carry a `style` block; nothing else changes |

Refusals (`validate_manifest` and `validate_tokens` in `crates/decks-packs/src/lib.rs`, quoted exactly;
`<n>` is the declared version):

| Case | Message |
|---|---|
| `v` above 2 | `manifest version <n> is not supported: this pack needs a newer MixAI Decks (this version reads 1 and 2)` |
| `v` 0 | `unsupported manifest version 0 (expected 1 or 2)` |
| `v` not an unsigned integer | `manifest.json is invalid: …` (the JSON parser's own text follows) |
| `style` in a `v` 1 pack (even `{}`) | `tokens.style needs manifest version 2 (this pack declares "v": 1)` |

**Compatibility.** Decks 1.4.0 refuses every `v` 2 pack with
`unsupported manifest version 2 (expected 1)` (its validator, read from the 1.4.0 source); it never
installs half of a skin. Keep `v` 1 unless the pack uses `style`. A `v` 1 pack is unchanged and works
everywhere. Separately, a layout that places the panel `waves` is not accepted by 1.4 and older
(`areas[<i>]: unknown panel`, see [layouts.md](layouts.md)) although layouts stay schema `"v": 1`.

### `tokens.json`

Flat shape (same as `PackTokens`) and/or a DTCG colour group — both are merged into `colors`:

```json
{
  "mode": "dark",
  "surface": "glass",
  "density": "compact",
  "radius": "md",
  "accent": "violet",
  "colors": { "primary": "oklch(0.72 0.19 300)", "border": "#ffffff22" },
  "color": { "$type": "color", "deck-a": { "$value": "#00e5ff" } },
  "decks": { "b": "oklch(70% 0.2 30 / 0.9)" },
  "fontHeading": "Space Grotesk",
  "fontBody": "Inter",
  "background": "assets/bg.webp"
}
```

- Colours: `#rrggbb`, `#rrggbbaa`, `oklch(L C H)` or `oklch(L C H / A)` only, with L 0–1 (or 0–100 %),
  C 0–0.5, H 0–360, A 0–1 (or %). No `url()`, `var()`, `calc()` or named colours.
- `colors` keys (CSS custom properties, without `--`): background, foreground, card, card-foreground,
  popover, popover-foreground, primary, primary-foreground, secondary, secondary-foreground, muted,
  muted-foreground, accent, accent-foreground, destructive, border, input, ring, deck-a, deck-b,
  deck-c, deck-d, success, warning. Anything else is refused.
- `accent`: a colour or a design-system accent name (lowercase slug).
- `mode` dark|light, `surface` glass|solid|flat, `density` comfortable|compact, `radius` sm|md|lg.
- `background` must point to an image inside the pack; it is returned as a `data:` URL in
  `PackInfo.assets` (with the declared fonts).
- `style` (manifest `v` 2 only): see the next section. `"style": null` is the same as no style block.
- Any other top-level key is refused (`unknown token '<key>' in <tokens file>`); keys starting with `$`
  are ignored.

## Style block (manifest v 2, Decks 1.5)

What a skin may change beyond the theme colours: the base look, the layout it opens with, the waveform
arrangement, colours of controls / waveforms / hot cues, and a few sizes. Declarative data only: a
colour, a bounded number or a fixed word; no CSS, no selectors, no URLs. One list, three mirrors that
must change together: `apps/mixai/src/look/style-vars.ts` (the app), `crates/decks-packs/src/style.rs`
(the verifier; its test `lists_match_style_vars_ts` reads the TS file and fails on drift) and
`apps/mixai/sdk/lib/validate.mjs` (the Skin SDK).

Every key is optional. Keys of `style`: `look`, `platter`, `layout`, `waves`, `colors`, `sizes`.

| Key | Values | Effect |
|---|---|---|
| `look` | `signature` (default) or `classic` | Base look the skin builds on: `data-look` on `<html>`. `classic` is the glass look of Decks 1.x |
| `platter` | `true` / `false` | `true` shows the virtual platter in the decks while the skin is active. `false` (or absent) leaves the user's own setting (Settings → Appearance) in charge; it does not hide the platter |
| `layout` | a layout id, `^[a-z0-9][a-z0-9._-]{0,47}$` | Layout to switch to when the user picks the skin. Resolved to a layout bundled in the same pack first (`<packId>/<id>`), else to a built-in or user layout with that id (`pro`, `pro-vertical`, `classic`, `performance`, `library`, `four-deck`, `ultrawide`). An id that resolves to nothing keeps the current layout |
| `waves` | `stacked` (default) or `overlay` | Arrangement of the waves panel: one lane per deck, or all decks in one lane |
| `colors` | object, keys below | Colours of controls, waveforms and hot cues |
| `sizes` | object, keys below | Gaps, radii, heights, one alpha |

Layout switching follows a skin change the **user** makes (never a startup render and never the 30 s
try): the layout that was active before is remembered, and comes back when the user leaves the skin,
unless they picked another layout in the meantime (`applySkinLayout` in `src/packs/pack-store.ts`).

### `style.colors`

Value grammar: the same as every other pack colour (`#rrggbb`, `#rrggbbaa`, `oklch(L C H)`,
`oklch(L C H / A)` with L 0–1 or 0–100 %, C 0–0.5, H 0–360, A 0–1 or %), **ASCII only and without a
minus sign** (`valid_style_color`). Each key sets one CSS custom property on `:root[data-skin]`. The
"default" column is what the Signature look uses when the skin does not set the key (`look/look.css`).

| Key | CSS property | What it colours | Signature default |
|---|---|---|---|
| `well` | `--well` | recessed wells: pads, readout blocks, lists | `oklch(0.125 0.008 165)` (dark) |
| `waveBg` | `--wave-bg` | waveform backdrop | `oklch(0.07 0.006 165)` (dark) |
| `line` | `--line` | control lines | the `border` theme colour |
| `faint` | `--fg-faint` | third text level: micro labels, column headers | `oklch(0.65 0.012 165)` (dark) |
| `on` | `--on` | ON state of toggles, tabs, sync, selected cells | the `primary` theme colour |
| `onFg` | `--on-fg` | text on an ON fill | `primary-foreground` |
| `play` | `--skin-play` | PLAY, fixed for every deck | unset: PLAY takes the deck colour inside a deck, the accent outside |
| `playFg` | `--play-fg` | label on PLAY | `background` |
| `cue` | `--cue-btn` | CUE button | `warning` |
| `alert` | `--alert` | end-of-track alert | `destructive` |
| `waveLow` | `--skin-wave-low` | waveform, low band | unset: 52 % deck colour mixed with black |
| `waveMid` | `--skin-wave-mid` | waveform, mid band | unset: the deck colour |
| `waveHigh` | `--skin-wave-high` | waveform, high band | unset: 42 % deck colour mixed with white |
| `waveGrid` | `--wave-grid` | beat grid on waveforms | `foreground` |
| `waveDownbeat` | `--wave-downbeat` | downbeat lines | `foreground` |
| `wavePlayhead` | `--wave-playhead` | playhead | `foreground` |
| `wavePlayheadCap` | `--wave-playhead-cap` | playhead cap | `destructive` |
| `cue1` … `cue8` | `--cue-1` … `--cue-8` | hot cues 1–8 | red, orange, blue, yellow, green, magenta, cyan, purple |

Setting `waveLow` / `waveMid` / `waveHigh` gives every deck the same band colours; leaving them out
keeps three tones of each deck's own colour (`tokens.decks`).

### `style.sizes`

Numbers, limits included (`STYLE_SIZES`). "px" = the app appends `px`; "—" = unitless.

| Key | CSS property | Range | Unit | Signature default |
|---|---|---|---|---|
| `panelGap` | `--panel-gap` | 0–16 | — (read as px between panels by the layout engine) | 2 |
| `panelRadius` | `--panel-radius` | 0–16 | px | 2 |
| `panelPad` | `--panel-pad` | 4–16 | px | 8 |
| `controlRadius` | `--ctl-radius` | 0–12 | px | 3 |
| `padRadius` | `--pad-radius` | 0–12 | px | 3 |
| `controlHeight` | `--ctl-h` | 20–32 | px | 24 (28 in booth mode) |
| `titlebarHeight` | `--titlebar-h` | 28–48 | px | 36 |
| `wavePlayedAlpha` | `--wave-played-alpha` | 0.2–1 | — | 0.4 |

`panelGap` only applies to layouts that do not set their own `gap` (see layouts.md § Gap).

### Validation and refusal messages

The Rust verifier (`validate_style` / `parse_style` in `crates/decks-packs/src/style.rs`) runs on
inspect, install, every listing and on `pack_build` / `pack_export`. A pack with any problem is
refused whole. Every problem is reported at once, joined with `; `, in this order: unknown keys, `look`,
`platter`, `layout`, `waves`, `colors`, `sizes` (several bad entries of one object come in key order).
Messages, quoted exactly (`<key>` is cut to 80 characters):

| Problem | Message |
|---|---|
| `style` is not an object | `style must be an object` |
| key other than the six above | `unknown style key '<key>'` |
| `look` not one of the two words (also `null`) | `style.look must be signature or classic` |
| `platter` not a boolean | `style.platter must be true or false` |
| `layout` not a string matching the id rule | `style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)` |
| `waves` not one of the two words | `style.waves must be stacked or overlay` |
| `colors` not an object (also `null`) | `style.colors must be an object` |
| colour key not in the table | `unknown style colour '<key>'` |
| colour value not in the grammar (name, `url()`, out of range, leading space, minus sign, non-ASCII space, a number) | `style.colors.<key> must be a valid colour` |
| `sizes` not an object | `style.sizes must be an object` |
| size key not in the table | `unknown style size '<key>'` |
| size not a number inside its range | `style.sizes.<key> must be a number in <min>..<max>` (e.g. `style.sizes.panelGap must be a number in 0..16`, `style.sizes.wavePlayedAlpha must be a number in 0.2..1`) |

On its side the app re-checks every entry when it writes the CSS (`styleDecls` in `style-vars.ts`): its
colour check is a looser regular expression than the Rust grammar, and an entry that fails it is
dropped, never written. `validateStyle` in the same file returns the messages above; on 2026-11-10 it
is called only by tests (the refusal a user sees comes from Rust). The Skin SDK applies the same rules
before packing and adds one warning: a `style.layout` that is neither a built-in id nor a layout of the
pack (`… the app will keep the current layout`).

### Example `tokens.json` (manifest `v` 2)

```json
{
  "mode": "dark",
  "surface": "solid",
  "density": "compact",
  "radius": "sm",
  "accent": "#00d37f",
  "colors": { "background": "#050607", "primary": "oklch(0.8 0.2 150)" },
  "decks": { "a": "#00e5ff", "b": "#ff2bd6" },
  "fontHeading": "Inter",
  "fontBody": "Inter",
  "style": {
    "look": "classic",
    "platter": true,
    "layout": "pro-vertical",
    "waves": "overlay",
    "colors": {
      "well": "#0b0d0f",
      "waveLow": "oklch(0.6 0.2 250)",
      "waveMid": "#33cc88",
      "waveHigh": "#ffffffcc",
      "cue1": "#ff0000",
      "cue8": "#00ff00"
    },
    "sizes": {
      "panelGap": 6.5,
      "panelRadius": 0,
      "panelPad": 16,
      "controlRadius": 2.5,
      "padRadius": 12,
      "controlHeight": 24.5,
      "titlebarHeight": 28,
      "wavePlayedAlpha": 0.45
    }
  }
}
```

These are the tokens of the `decks-packs` export test (`built_skin_inspects_with_the_same_tokens`): the
built pack inspects, installs and returns the same object. The manifest next to it needs `"v": 2`.

## Limits (zip-bomb and abuse guards)

| Limit | Value |
|---|---|
| Archive size | ≤ 25 MB |
| Entries | ≤ 200 |
| One entry, uncompressed | ≤ 10 MB (actual read is capped too, headers are not trusted) |
| Total uncompressed | ≤ 60 MB |
| Compression ratio per entry | ≤ 100 (entries ≥ 64 KB) |
| Layout file | ≤ 64 KB, JSON object |
| Preview returned to the UI | ≤ 512 KB (larger previews are just not inlined) |

Entry names must be relative, `/`-separated, with no `..`/`.`/empty segments, no backslash, no
`:` and no control characters. Symlinks, encrypted entries, duplicate names and other compression
methods are refused. Allowed extensions: `.json .png .jpg .jpeg .webp .avif .woff2` (SVG is
deliberately excluded: it can carry script).

## Signing

`signature.json`:

```json
{ "alg": "ed25519", "keyId": "mixai-official-2026", "sig": "<base64 64 bytes>", "pubkey": "<base64 32 bytes, optional>" }
```

The signature covers the SHA-256 of this canonical byte string: for every entry except
`signature.json`, sorted by name (byte order), the line `<name>\n<sha256 hex of entry bytes>\n`,
concatenated. Verification uses `verify_strict`. Any change to any file (or adding/removing one)
invalidates the signature, and an invalid signature means the pack is **rejected**, not downgraded.

`pack::sign_pack(zip_bytes, &signing_key, key_id)` re-packs a zip with a fresh `signature.json`
(embedding the public key); the Skin SDK and the tests use it.

## Trust levels

| Trust | Meaning |
|---|---|
| `official` | `keyId` is in the compiled-in `OFFICIAL_KEYS` table and the signature verifies against that key |
| `verified` | `keyId` is in `VERIFIED_KEYS` (vetted creators; empty for now) |
| `community` | valid signature by the key embedded in `pubkey`, not in either table (proves integrity, not identity) |
| `unsigned` | no `signature.json` |

A pack that claims an official/verified `keyId` is always checked against the table key, never
against its embedded `pubkey`, so it cannot impersonate MixAI.

### Official key

- Key id: `mixai-official-2026`. Public key compiled into `OFFICIAL_KEYS` in `pack.rs`.
- Private key (32-byte Ed25519 seed, base64): `C:\Users\vladu\.mixai\pack-signing-key.txt` on the
  maintainer workstation, **outside the repo, never committed or printed**. Generated 2026-11-09 with
  `.copilot-tmp/redesign-rust/genkey.mjs` (node:crypto).
- TODO for CI signing: move the seed to GCP Secret Manager (project `mmo-mw-prod`, e.g. secret
  `mixai-pack-signing-key`) and delete the local copy. Rotation = add a new key id
  (`mixai-official-2027`) to `OFFICIAL_KEYS`, ship an app release, then re-sign the official packs.

## Storage

`pack_install` stores the archive at `<app_data_dir>/packs/<id>.mixaipack` and records
`{ id: { sha256, installedAt } }` in `<app_data_dir>/packs/index.json` (atomic writes).
`pack_list` re-validates every stored archive on read and skips (with a log line) any that no
longer pass validation or no longer match the indexed hash. `pack_remove` deletes both.

## Commands

| Command | Args | Returns |
|---|---|---|
| `pack_inspect` | raw body (`invoke(cmd, Uint8Array)`) | `PackInfo` (validate + verify, nothing stored; used for the 30 s try) |
| `pack_install` | raw body (`invoke(cmd, Uint8Array)`) | `PackInfo` with `installedAt` |
| `pack_list` | — | `PackInfo[]` |
| `pack_remove` | `id` | — |
| `pack_pick_file` | — | raw `ArrayBuffer`; empty = cancelled (native file dialog, `.mixaipack`, ≤ 25 MB) |
| `pack_build` (1.5) | `req`: `PackExportRequest` | raw `ArrayBuffer`: the bytes of an unsigned skin pack, no dialog |
| `pack_export` (1.5) | `req`: `PackExportRequest` | saved path, or `null` when the save dialog was cancelled |

Errors are plain English strings meant to be shown to the user.

Pack bytes never cross IPC as a JSON number array (since Decks 1.3.1); a JSON body is refused.

### Building a skin pack (`pack_build` / `pack_export`, 1.5)

Both commands wrap `build_skin_pack` (`crates/decks-packs/src/export.rs`). Request (camelCase, unknown
fields refused): `id`, `name`, `author`, `description` (may be left out), `version`
(`MAJOR.MINOR.PATCH`), `tokens` (the `tokens.json` content, optionally with `style`).

- Output: a zip with exactly `manifest.json` (`"v": 2`, `"kind": "skin"`, `"pro": false`,
  `"tokens": "tokens.json"`) and `tokens.json`; no `signature.json`, so it inspects as **unsigned**.
- The result goes through the install-time validation before it is returned: what was built installs.
  An invalid request is refused with the same messages as an install, before any dialog opens.
- Deterministic: the same request gives the same bytes (fixed entry order and timestamps).
- An unsigned pack may not use a reserved identity:
  `ids starting with 'ro.mixai.' and the author 'MixAI' are reserved for official packs`.
- `pack_export` opens a save dialog with the default name `<id>.mixaipack`; `.mixaipack` is appended
  when the chosen name does not end with it, and if that other file already exists the export is
  refused (`<path> already exists; pick that file in the dialog to replace it`).

These commands are what the live skin editor calls ("Save as my skin" and "Export .mixaipack"); see
[skins.md](skins.md). To sign a
built pack, unpack it and `pack --sign` it with the Skin SDK (`apps/mixai/sdk/README.md`).

## Layout ids

A layout inside a pack keeps its own slug id; in the app it becomes `<packId>/<layoutId>`
(e.g. `ro.mixai.bundle.festival-pro/festival-4`). The `/` can not occur in built-in or user
layout ids, so a pack can not shadow a built-in, overwrite a user layout, or collide with another
pack. Bare refs saved by 1.3.0 (active layout, snapshots, controller bindings) are remapped when
exactly one pack layout matches. Code: `apps/mixai/src/packs/pack-layouts.ts`.

## Webview CSP

`tauri.conf.json` sets a CSP (since 1.3.1): scripts `'self'` only, network `ipc:` + `https://mixai.ro`,
images/fonts `'self' data:` (+ marketplace previews), no frames/objects. `style-src` keeps
`'unsafe-inline'` (skins inject a `<style>`), so Tauri's nonce injection is disabled for it only.

## Native apps (Android, Desktop, iOS/iPadOS/macOS) — WP19-34

One verifier for every surface: the pure part of the old `src-tauri/src/pack.rs` (limits, archive
guards, `canonical_digest`, Ed25519 `verify_strict`, manifest / token / layout validation,
`inspect_with`, `sign_pack`) lives in the crate **`apps/mixai/src-tauri/crates/decks-packs`**
(MIT OR Apache-2.0, MSRV 1.90), together with a path-based **`PackStore { dir }`**
(`<dir>/<id>.mixaipack` + `index.json`, atomic writes, re-verification on `list`, a less trusted pack
never replaces a more trusted one). The Tauri commands above are now thin wrappers over it
(`src-tauri/src/pack.rs` keeps only the commands and `raw_body`); names, signatures and the camelCase
wire shape are unchanged.

`decks-ffi` exports it to Kotlin and Swift (`crates/decks-ffi/src/packs.rs`, tests in
`crates/decks-ffi/tests/packs.rs`):

| FFI | Returns |
|---|---|
| `pack_inspect(bytes)` | `PackSummary` record: id, name, version, kind, author, description, pro, trust, sha256, size, installed_at?, mode?, accent?, `colors: [PackColor]`, `layouts_json` (namespaced), `info_json` (the full camelCase `PackInfo`); since 1.5 also `manifest_v` (1 or 2) and `style?` (`PackStyle`: look?, platter?, layout?, waves?, `colors: [PackColor]` resolved to sRGB, `sizes: [{ key, value }]`) |
| `PackStore(dir)` · `install(bytes)` · `list()` · `remove(id)` · `layouts_json()` · `dir()` | object over `decks_packs::PackStore` |
| `pack_resolve_colors(tokens_json)` | `[PackColor { key, rgb: 0xRRGGBB, alpha }]` from a flat or DTCG tokens object; `decks.a..d` → `deck-a..deck-d`, a colour `accent` → `accent` |
| `pack_build_skin(request_json)` (1.5) | bytes of an unsigned skin `.mixaipack` from a `PackExportRequest` JSON (same builder as `pack_build`); a malformed request answers `export request is invalid: …` |

The native apps **verify** v 2 packs with this shared code. **Applying** the `style` block of an
installed pack in the Compose and SwiftUI apps (look, platter, waves, style colours and sizes) is not
built: the block reaches Kotlin (`PackSummaryUi.style`) and is ignored (2026-11-11).

Native code never parses zip, Ed25519 or `oklch(...)`: every colour arrives as packed sRGB
(OKLCH → sRGB uses the same constants as packages/design-tokens). Errors are `DecksError::Pack { reason }`
with the same English strings as the desktop.

Where packs live: Android `filesDir/packs`, Desktop `~/.mixai-decks/packs`, iOS / macOS
`Application Support/packs`. Import: Android SAF (`OpenDocument`), Desktop a file dialog
(`*.mixaipack`), iOS/macOS `fileImporter` with the exported UTType **`ro.mixai.mixaipack`**
(extension `mixaipack`, conforms to `public.zip-archive`; declared through `apps/ios/project.yml`).
A skin or bundle pack becomes the colour source of the active skin: Kotlin `DecksSkin.packId` →
`DecksPalette(skin, overrides)`, Swift `AppearanceStore.packId` → `DecksPalette.shared`. Supported
override keys are the `COLOR_KEYS` above; roles the native palettes do not have (e.g. `popover`) are ignored.
