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
| `pack_inspect` | `bytes: number[]` | `PackInfo` (validate + verify, nothing stored; used for the 30 s try) |
| `pack_install` | `bytes: number[]` | `PackInfo` with `installedAt` |
| `pack_list` | — | `PackInfo[]` |
| `pack_remove` | `id` | — |
| `pack_pick_file` | — | `number[] \| null` (native file dialog, `.mixaipack`, ≤ 25 MB) |

Errors are plain English strings meant to be shown to the user.
