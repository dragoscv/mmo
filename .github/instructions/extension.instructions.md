---
applyTo: "apps/extension/**"
description: "Browser extension (vanilla MV3): dual version bump, _locales parity, vendored polyfill, scoped tokens"
---

# apps/extension — MixAI browser extension (Manifest V3, vanilla JS)

## Rules
- MV3 only (`manifest_version: 3`); `extension-ci` fails otherwise. Background = service worker; no remote code.
- **Two version fields move together**: `apps/extension/manifest.json` AND `apps/extension/package.json`.
  Husky `node apps/extension/scripts/check-version.mjs --staged` blocks a commit that stages any file under
  `apps/extension/` without bumping BOTH vs the merge base; CI re-runs with `--base=origin/main`. Current 3.0.0.
- i18n: `_locales/en/messages.json` + `_locales/ro/messages.json` via `i18n.js` — add every key to both.
- Styling: `apps/extension/tokens.css` is a GENERATED mirror of `tokens.plain.css` (`pnpm tokens:build`) —
  never edit by hand. `content.css` must NOT load `tokens.css` into the host page (it would restyle the host
  `:root`); OKLCH vars are scoped on `#mixai-download-btn`. Popup/options may use `tokens.css` directly.
- `vendor/browser-polyfill.min.js` is pinned: regenerate with `pnpm run vendor:polyfill`; CI fails if
  `git status --porcelain vendor/` is non-empty after the refresh.
- Deep link into the web app: `/download` accepts only `url`, `auto`, `tab`, `q`, `expanded` today (the
  `audio=1` param is ignored by web) — add web support before sending new params.
- No lockfile churn: deps via `pnpm add --ignore-workspace` inside `apps/extension`; CI installs with
  `--no-frozen-lockfile` for this app only.
- Release: tag `extension-v*` → `extension-release.yml`.

## Commands (from `apps/extension`)
- `node scripts/check-version.mjs` (vs origin/main) / `--staged` / `--base=<ref>`.
- `pnpm run vendor:polyfill`.
- Manifest sanity: `node -e "const m=require('./manifest.json'); if(m.manifest_version!==3) process.exit(1)"`.
- Load unpacked in Chrome/Edge: `chrome://extensions` → Developer mode → the `apps/extension` folder.

## Gotchas
- `create_file` / whole-file overwrite of a tracked file may be refused by the harness → copy from
  `.copilot-tmp` with `Copy-Item` or use targeted edits.
- Forgetting one of the two version files is the most common husky failure here; the script prints which.
- Brand: the button/popup text is "MixAI" (README used to describe unimplemented adapters — verify against code).

## Verify
- `node apps/extension/scripts/check-version.mjs --staged` exits 0 with the staged set.
- `pnpm run vendor:polyfill; git --no-pager status --short apps/extension/vendor` → empty.
- `git --no-pager diff --stat apps/extension/tokens.css` empty unless a tokens change was regenerated.
- Both `_locales/*/messages.json` parse and have identical key sets:
  `node -e "const a=require('./_locales/en/messages.json'),b=require('./_locales/ro/messages.json');const d=Object.keys(a).filter(k=>!b[k]).concat(Object.keys(b).filter(k=>!a[k]));if(d.length){console.error(d);process.exit(1)}"`.
