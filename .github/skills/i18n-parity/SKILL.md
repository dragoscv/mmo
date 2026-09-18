---
name: i18n-parity
description: Add or change user-facing strings across MixAI surfaces and prove RO/EN parity — web next-intl messages/{en,ro}.json, extension _locales, tv-tizen messages.ts, tv-android values/values-ro, plus the planned parity gate script. Use when adding UI copy, when a key exists in one locale only, when labels show raw keys, or before committing anything under messages/ or _locales/. Trigger words: i18n, next-intl, ro.json, en.json, _locales, parity, translation missing, hardcoded Romanian.
---

# i18n parity (RO default + EN everywhere)

Locales: `ro` (default) and `en` (`apps/web/src/i18n/locales.ts` `SUPPORTED_LOCALES`). The user's locale is
`mixai:prefs:v1`.locale, mirrored on web to the `mmo-locale` cookie and to `lang` on `<html>`. Every new string
ships in BOTH languages on the surface where it appears; hardcoded RO/EN literals in components are bugs.

## Where strings live
| Surface | Files | Access |
|---|---|---|
| web | `apps/web/messages/en.json`, `apps/web/messages/ro.json` (namespaces: `nav`, `common`, `settings.<domain>`, `library`, `watch`, `dashboard`, `palette`, `shortcuts`, …) | `useTranslations("ns")` / `getTranslations` |
| extension | `apps/extension/_locales/{en,ro}/messages.json` | `i18n.js` → `chrome.i18n.getMessage` |
| tv-tizen | `apps/tv-tizen/src/i18n/messages.ts` (`t()`, `setLocale`, `mixai:locale` event) | `t("key")` |
| tv-android | `app/src/main/res/values/strings.xml`, `values-ro/strings.xml` | `stringResource(R.string.x)` |
| @mmo/ui | `packages/ui/src/i18n/*` (shared primitive strings) | via `ThemeProvider` locale |
| mixai DJ / companion | RO default labels (`Setări`, `Luminos`, `Plat`) — check `src/i18n` in each app | — |

## Procedure
1. Find the namespace by neighbour: `rg -n '"library"' apps/web/messages/en.json` then add the key in **en.json
   AND ro.json** at the same nesting (ro.json nests `settings` ~line 24, 3 levels deep — match the exact path).
2. Use the key in code (`t("library.emptyState.title")`), never a literal. Interpolations `{count}` identical in
   both files; ICU plurals if needed.
3. Other surfaces mirroring the same feature (TV, extension) get the same key in their own files.
4. Sweep for leftovers you may have introduced:
   `rg -n '"[A-ZĂÂÎȘȚ][a-zăâîșț]+ [a-zăâîșț ]{4,}"' apps/web/src/components/<area> -g '*.tsx'` (RO sentences in JSX).
5. Parity check — script `apps/web/scripts/i18n-parity.mjs` (added in WP13-03; planned to run in lint-staged and
   web-ci). Until it lands, run the equivalent one-liner from `apps/web`:
   ```powershell
   node -e "const f=p=>Object.keys((function w(o,k=''){return Object.entries(o).reduce((a,[x,v])=>typeof v==='object'?{...a,...w(v,k+x+'.')}:{...a,[k+x]:1},{})})(require(p)));const a=f('./messages/en.json'),b=f('./messages/ro.json');const d=[...a.filter(k=>!b.includes(k)).map(k=>'ro missing '+k),...b.filter(k=>!a.includes(k)).map(k=>'en missing '+k)];console.log(d.join('\n')||'PARITY OK');process.exit(d.length?1:0)"
   ```
   Extension: same idea on `_locales/en` vs `_locales/ro` (flat keys). tv-android: `lint` reports
   `MissingTranslation` when `values-ro` lacks a key.
6. Stage both locale files together with the component. Web staging triggers the version-bump gate
   (skill `release-bump`).

## Verify
- Parity command prints `PARITY OK` (exit 0) for web; extension key sets identical; Android lint has no
  `MissingTranslation`.
- Runtime: switch locale in `<ThemeSettings/>` (or set `mixai:prefs:v1`.locale) → the new copy renders in both
  languages, no raw `namespace.key` text (Playwright: `page.getByText(/^[a-z]+\.[a-zA-Z.]+$/)` finds nothing).
- `rg -n "<your literal>" apps/web/src` returns only the messages files.

## Common failures
- Key added to `en.json` only → renders the English fallback in RO or the raw key; the parity script catches it.
- Wrong nesting in `ro.json` (top-level `settings` vs `settings` inside another block) → key exists but is
  unreachable; compare flattened paths, not line positions.
- Server components: `getTranslations` (async), client: `useTranslations`; mixing them is a build error.
- Tizen `t()` reads the shared prefs blob — set `localStorage["mixai:prefs:v1"]` in tests, not `mmo-locale`.
- JSON with a trailing comma or BOM breaks `next-intl` at build (`Unexpected token`); keep LF, no BOM.
- Playwright regexes must match RO by default (`Setări`, not `Settings`).
