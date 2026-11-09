# MixAI Decks Skin SDK (`mixaipack`)

Make skins, layouts and bundles for MixAI Decks as `.mixaipack` files. Zero dependencies:
Node 24+ only. Format reference: [`docs/decks/packs.md`](../../../docs/decks/packs.md). The app
verifies every pack in Rust (`apps/mixai/src-tauri/src/pack.rs`); this CLI applies the same rules
first, so a pack that passes `validate` installs.

```powershell
node apps/mixai/sdk/mixaipack.mjs help
```

## Make a skin in five minutes

```powershell
node apps/mixai/sdk/mixaipack.mjs init my-skin --kind skin --id com.yourname.skin.sunset --name "Sunset"
# edit my-skin/tokens.json
node apps/mixai/sdk/mixaipack.mjs preview my-skin      # redraw assets/preview.png from your palette
node apps/mixai/sdk/mixaipack.mjs validate my-skin
node apps/mixai/sdk/mixaipack.mjs pack my-skin -o com.yourname.skin.sunset.mixaipack
```

Then in MixAI Decks: **Skins → Install from file**. You can try a pack for 30 seconds before installing it.

`--kind layout` scaffolds `layouts/example.json`; `--kind bundle` scaffolds both tokens and a layout.
`README.md` files and dotfiles in the pack folder are never packed.

### `tokens.json`

```json
{
  "mode": "dark",
  "surface": "glass",
  "radius": "md",
  "colors": {
    "background": "oklch(0.16 0.02 270)",
    "foreground": "oklch(0.96 0.01 270)",
    "primary": "#ff2bd6",
    "primary-foreground": "#12001a",
    "deck-a": "#00e5ff"
  }
}
```

- Colours: `#rrggbb`, `#rrggbbaa`, `oklch(L C H)` or `oklch(L C H / A)`. No names, `rgb()`, `var()` or `url()`.
- Colour keys: background, foreground, card, card-foreground, popover, popover-foreground, primary,
  primary-foreground, secondary, secondary-foreground, muted, muted-foreground, accent,
  accent-foreground, destructive, border, input, ring, deck-a … deck-d, success, warning.
- `mode` dark|light · `surface` glass|solid|flat · `density` comfortable|compact · `radius` sm|md|lg ·
  `fontHeading`/`fontBody` (declare the `.woff2` in `manifest.fonts`) · `background` (an image in the pack).

### Contrast gate

`validate` and `pack` refuse a skin whose text is hard to read (WCAG 2.2 AA): foreground/background,
card-foreground/card, muted-foreground/background and primary-foreground/primary need 4.5:1; ring on
background needs 3:1. Only pairs you actually set are checked. `--allow-low-contrast` turns these into
warnings (for experiments; such skins will not be accepted as verified).

### Layouts

A layout is a grid of weighted columns/rows with panels placed on it (the same schema as the
built-in layouts in `apps/mixai/src/layout/presets.ts`). Panels: deckA, deckB, deckC, deckD,
clock, mixer, crossfader, library, automix, sampler, plugins. deckA, deckB and mixer are required;
panels may not overlap or leave the grid; 1–8 columns/rows with weights in (0, 20]; gap 0–32.

## Import from Figma

Export your variables as DTCG JSON (Figma variables export, or Tokens Studio "Export to file"):

```powershell
node apps/mixai/sdk/mixaipack.mjs import-dtcg figma-tokens.json my-skin
```

- Nested groups, `$value`/`$type` (also the older Tokens Studio `value`/`type`) and aliases like
  `{core.violet}` (chains too) are resolved.
- Names are mapped to the keys above: exact names (`background`, `color.primary`, `deck/a`,
  `primary/foreground`) and common ones (`bg`, `surface` → background; `text`, `fg` → foreground;
  `brand` → primary; `on-primary` → primary-foreground; `text-muted` → muted-foreground; `error` →
  destructive; `focus` → ring; `deck-1` → deck-a …). Anything else is listed as unmapped.
- `#rgb`, `rgb()`, `hsl()` become `#rrggbb[aa]`; `oklch()` is kept.
- The result is merged into an existing `tokens.json` (other fields kept). Run `validate` afterwards.

## Signing and trust

| Trust | How |
|---|---|
| **Official** | Signed by MixAI (`mixai-official-2026`), built by `apps/mixai/packs-src/build.mjs` |
| **Verified** | Signed by a vetted creator key (programme not open yet) |
| **Community** | Signed with your own key, public key embedded: proves the file was not changed, not who made it |
| **Unsigned** | No signature; installs with a warning |

Sign with your own Ed25519 key (a base64 32-byte seed in a file you keep private):

```powershell
node -e "const c=require('node:crypto');const d=c.generateKeyPairSync('ed25519').privateKey.export({format:'der',type:'pkcs8'});require('node:fs').writeFileSync('my-key.txt',d.subarray(-32).toString('base64'))"
node apps/mixai/sdk/mixaipack.mjs pack my-skin -o out.mixaipack --sign my-key.txt --key-id yourname-2026 --embed-pubkey
```

The signature covers every file (SHA-256 per file, sorted list, Ed25519 over the digest). Changing,
adding or removing any file afterwards makes the app **reject** the pack. Never commit or share your key file.

## Limits

Archive ≤ 25 MB · ≤ 200 files · one file ≤ 10 MB · total ≤ 60 MB · layout ≤ 64 KB · preview shown
in the app ≤ 512 KB. File types: `.json .png .jpg .jpeg .webp .avif .woff2` (no SVG, JS or CSS).
Names: relative `/` paths, no `..`, backslashes, `:` or control characters.

## Catalogue (maintainers)

```powershell
node apps/mixai/packs-src/build.mjs            # official packs -> apps/web/src/lib/decks-packs/
node apps/mixai/sdk/mixaipack.mjs catalog <dir> -o catalog.json --base-url /api/decks/packs --previews <dir>
```

`build.mjs` reads the official seed from `%USERPROFILE%\.mixai\pack-signing-key.txt` (or
`MIXAI_PACK_SIGNING_KEY_FILE` / `--key`) at build time only; it is never printed or copied into the repo.
The web app serves the result at `/api/decks/packs` (catalogue), `/api/decks/packs/<id>/download` and
`/api/decks/packs/<id>/preview`.

## Submit a pack

For now: open a GitHub issue at <https://github.com/dragoscv/mmo/issues> titled `Pack: <name>` with the
`.mixaipack` attached. Include the `validate` output. Accepted
packs are re-signed as **Verified** once the creator programme opens.

## Development

```powershell
node --test apps/mixai/sdk/test/*.test.mjs
node apps/mixai/sdk/tools/make-fixture.mjs     # regenerate fixtures/sample-signed.mixaipack
```

`fixtures/sample-signed.mixaipack` is signed with a **public test key** (`tools/fixture.mjs`,
key id `mixai-sdk-test`, community trust) for the Rust cross-check; it must inspect as
`trust = community`, id `com.example.test.sample`.
