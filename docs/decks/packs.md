# `.mixaipack` — skins, layouts and controller packs for MixAI Decks

A pack is **declarative data only**: JSON, raster images and woff2 fonts. No JavaScript, no
CSS, no SVG. Every pack is validated and (when signed) verified in Rust
(`apps/mixai/src-tauri/src/pack.rs`) before the UI sees it; the UI then validates layout JSON a
second time. TS contract: `apps/mixai/src/bridge/packs.ts`.

## Archive format

A `.mixaipack` file is a zip (entries `Stored` or `Deflated` only):

| Path | Required | Content |
|---|---|---|
| `manifest.json` | yes | `PackManifest` (below) |
| `tokens.json` | for skins | theme tokens (flat `PackTokens` and/or DTCG `color` group) |
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

- `v` must be `1`; unknown fields are rejected.
- `id`: `^[a-z0-9]+(\.[a-z0-9-]+){1,6}$`, ≤ 100 chars. Installing a pack with the same id replaces it.
- `name` and `author` 1–60 chars, `description` ≤ 500, `version` `MAJOR.MINOR.PATCH`.
- `kind`: `skin` | `layout` | `bundle` | `controller`.
- `pro`: requires Decks Pro; enforced by the UI, Rust only stores.
- Every referenced file must exist in the zip with the right type (tokens/layouts/presets `.json`,
  preview an image, fonts `.woff2`, font weight 100–900, family `^[A-Za-z0-9 \-]{1,40}$`).

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

Errors are plain English strings meant to be shown to the user.

Pack bytes never cross IPC as a JSON number array (since Decks 1.3.1); a JSON body is refused.

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
| `pack_inspect(bytes)` | `PackSummary` record: id, name, version, kind, author, description, pro, trust, sha256, size, installed_at?, mode?, accent?, `colors: [PackColor]`, `layouts_json` (namespaced), `info_json` (the full camelCase `PackInfo`) |
| `PackStore(dir)` · `install(bytes)` · `list()` · `remove(id)` · `layouts_json()` · `dir()` | object over `decks_packs::PackStore` |
| `pack_resolve_colors(tokens_json)` | `[PackColor { key, rgb: 0xRRGGBB, alpha }]` from a flat or DTCG tokens object; `decks.a..d` → `deck-a..deck-d`, a colour `accent` → `accent` |

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
