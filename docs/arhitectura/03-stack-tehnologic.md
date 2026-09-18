# 03 — Stack tehnologic

> [← 02](02-componente-suite.md) · [04 →](04-fluxuri-date.md)

Toate dependențele majore din MixAI / MMO, grupate pe componentă, cu **motivația** alegerii.
Versiunile de mai jos sunt cele **livrate** de overhaul-ul din 2026-09 (vezi
[design-system.md](../design-system.md), [tracker](../mixai-design-tracker.md),
[ADR-0008](../adr/0008-design-system-and-theme-prefs.md)). Regula: **ultimul major stabil**;
excepțiile (TS 7, ESLint 10 pe web) sunt notate cu motivul blocajului.

---

## 🌐 Web App (`apps/web/package.json`, v2.0.0)

### Framework & runtime

| Dependență | Versiune | De ce |
|---|---|---|
| `next` | 16.3.5 | App Router, RSC, Server Actions; `next build` rulează pe **Turbopack** (fallback `build:webpack`) |
| `react` / `react-dom` | 19.3.0 | `<ViewTransition>` și `<Activity>` **stabile** (folosite în `app/template.tsx` și NowPlaying), React Compiler |
| `typescript` | 5.9 | Strict mode. **TS 7 blocat** pe web: `typescript-eslint` nu are încă API pentru TS 7 (#10940); `packages/*`, mixai, tizen și server/ui sunt pe TS 7.0 |
| `eslint` | 9 (flat config) | **ESLint 10 blocat**: `eslint-plugin-react` 7.37 cere peer `^9.7` |
| `node` | ≥22 | Cerință Next.js 16 |

### Date & persistență

| Dependență | De ce |
|---|---|
| `drizzle-orm` 0.45 | SQL-first, type-safe, fără client codegen, suport multi-DB |
| `drizzle-kit` 0.31 | Migrations, `db:push` pentru dev rapid |
| `better-sqlite3` 12.9 | DB local zero-config; sincron, fast |
| `@auth/drizzle-adapter` 1.11 | Auth.js v5 cu Drizzle backend |
| `next-auth` 5.0.0-beta.31 | Auth.js v5 — multi-provider, edge-compatible |

### UI

| Dependență | De ce |
|---|---|
| `@mmo/design-tokens` (packages/) | **Sursa unică de tokens** — paletă OKLCH, dimensiuni de temă (mode/accent/surface/density/radius/motion), generator CSS/JSON/Kotlin/prehydrate. Vezi [design-system.md](../design-system.md) |
| `@mmo/ui` (packages/) | Componente partajate pe **Base UI** (`@base-ui/react` 1.8), ThemeProvider, motion presets, hooks, mesaje RO/EN |
| `tailwindcss` 4.3 | CSS-first config (`@theme`), compilat cu `@tailwindcss/cli` în `public/globals.css` |
| `@base-ui/react` 1.8 | Primitive headless accesibile (default shadcn din 2026-07; `render` prop în loc de `asChild`) |
| `@mmo/design-tokens` ThemeProvider | Înlocuiește `next-themes` (scos): mod/accent/suprafață/densitate/rază/mișcare în `mixai:prefs:v1`, `prehydrate.js` în `<head>` elimină flash-ul dark→light |
| `apps/web/src/components/ui/*` | **Wrappere subțiri** peste `@mmo/ui` (`asChild`→`render` prin `withAsChild`); Radix nu mai este o dependență directă |
| `class-variance-authority` 0.7 | Variants type-safe pentru componente |
| `clsx` + `tailwind-merge` 3.7 | Combinare clase Tailwind sigură |
| `lucide-react` 1.47 | Iconuri SVG, tree-shakable |
| `sonner` 2.0 | Toast notifications |
| `cmdk` 1.1 | Command palette (`CommandDialog` din `@mmo/ui`) |
| `motion` 13.4 | Animații (fost `framer-motion`; DAW timeline, transitions, `AnimateView` pe React 19.3 ViewTransition) |
| `@tanstack/react-table` 9.2 | `DataTable` din `@mmo/ui` (API `tableFeatures` + `useTable`, TanStack Store), prioritate de coloane și mod card pe mobil; folosit la companions / hidden / render-jobs / lora |
| `nuqs` 2.10 | Stare URL pentru filtre (`/library`), `NuqsAdapter` în layout, `shallow:false` re-rulează pagina server |
| `@serwist/next` 9 + `@serwist/cli` | Service worker (`public/sw.js`) în **mod configurator** (`serwist.config.mjs`, `next build && serwist build`) — singurul mod compatibil Turbopack; HTML/RSC = NetworkOnly, `/api/audio/*` cu fallback IndexedDB |
| `dockview` 5.2 | Layout cu panouri redimensionabile (DAW, mixer) |
| `react-grid-layout` 2.2 | Grid drag-drop (live mode pads) |
| `mobile-drag-drop` 3.0-rc | DnD touch pe mobile |
| `recharts` 3.8 | Grafice (waveforms, FFT, energy) |

### Audio & media

| Dependență | De ce |
|---|---|
| `music-metadata` 11.12 | Extragere ID3, FLAC tags, etc. (Node-side) |
| `node-id3` 0.2 | Scriere ID3 tags |
| `fast-xml-parser` 5.5 | Parse rekordbox XML |
| `Web Audio API` (browser) | Engine audio; folosit prin `src/lib/audio*` |
| `AudioWorklet` | Procesare audio off-main-thread (fade, EQ) |

### System

| Dependență | De ce |
|---|---|
| `systeminformation` 5.31 | CPU, RAM, disk stats pentru `/api/system-stats` |
| `sharp` 0.34 | Manipulare imagini (waveform-rgb, thumbnails) |

### Dev tools

| Dependență | De ce |
|---|---|
| `babel-plugin-react-compiler` 1.0 | Memoization automată React 19 |
| `vitest` 5 (+ `vite` 8 override) | Unit tests; `environmentMatchGlobs` decide node/jsdom după extensie |
| `@playwright/test` | E2E (`apps/web/e2e`) |

---

## 🎛️ MixAI DJ, TV, Companion UI — surfețe Vite

| Dependență | Unde | De ce |
|---|---|---|
| `vite` 8.3 (rolldown) | `apps/mixai`, `apps/tv-tizen`, `server/ui` | Build rapid; `manualChunks` doar în forma funcție; alias + `resolve.dedupe` pentru `react`/`@base-ui/react`/`motion` când consumă sursa `@mmo/ui` |
| `@vitejs/plugin-legacy` 8 | `apps/tv-tizen` | Tizen încarcă din `file://` fără `type="module"` → SystemJS classic; `@supports not (color: oklch())` fallback sRGB |
| `typescript` 7.0 | mixai, tizen, packages, server/ui | Native TS (Go); fără `baseUrl` (TS5102) |
| Compose for TV + Media3, AGP 9.4, Gradle 9.7, Kotlin 2.4 | `apps/tv-android` | AGP 9 = Kotlin built-in (fără plugin `kotlin.android`); `compileSdk 37` cerut de compose-bom 2026.09 / coil 3.6; culori din `Tokens.kt` generat |

---

## 🖥️ Companion / MMO Server (`server/package.json`, v3.0.0)

| Dependență | De ce |
|---|---|
| `electron` 44 | Cross-platform desktop app (Chromium 152, Node 24 în main); `pnpm.overrides.node-abi ^4.35` ca `install-app-deps` să recunoască ABI-ul |
| `electron-builder` 26.15 | Build NSIS/DMG/AppImage/deb/rpm; `app.asar` = `dist/**` + `ui/dist/**` + `assets/**`, native în `asarUnpack` |
| `electron-updater` | Auto-update din GitHub Releases |
| `express` 5 | HTTP server local (`path-to-regexp` v8: `/*name` wildcard, `router.param` în loc de regex inline) |
| `better-sqlite3` 13 + `drizzle-orm` 0.45 | SQLite N-API — un singur binar pentru Electron, Node 22 și Node de sistem |
| `chokidar` 5, `music-metadata` 11 | ESM-only → `import()` dinamic din build-ul CJS |
| Renderer: `vite` 8 + `react` 19 + `@mmo/ui` | Fereastra desktop (`server/ui`), înlocuiește `index.html`-ul vanilla; același API preload `window.mmo` |
| `electron-log` | Logging cross-platform |
| `SettingsStore` (propriu) | Înlocuiește `electron-store`; același `<userData>/config.json`, merge și headless (ADR-0002) |

> **De ce Electron și nu Tauri?** Tauri e mai mic și mai sigur, dar comunitatea Electron + maturity electron-builder + auto-update sunt încă imbatabile pentru un app cu audio nativ și hardware MIDI. Vom reevalua când Tauri 3 stabilizează `tauri-plugin-shell` și `tauri-plugin-fs-watch`.

---

## 📱 Native shells (`apps/native`, v1.0.0)

| Tehnologie | De ce |
|---|---|
| **Capacitor 8.5** | Ambalează PWA-ul web pentru Android/iOS; min/compile/target SDK 24/36/36, AGP 8.13; `AndroidManifest.xml` acum versionat |
| **Tauri 2.11** (Rust 2021) | Desktop nativ pentru MixAI DJ + shell nativ; Tauri 3 e încă alpha. `reqwest` 0.13 (feature `rustls`), `cpal` 0.15 / `symphonia` 0.5 pinuite (0.16+/0.6 cer refactor) |
| Safe-area + `standalone` | `--safe-*` din tokens, variantă Tailwind `standalone`, `<html data-standalone>` setat de `pwa-standalone.tsx` pentru PWA/Capacitor/Tauri |

---

## 🧩 Extension (`apps/extension/manifest.json`, v3.0.0)

| Tehnologie | De ce |
|---|---|
| **Manifest V3** | Cerință Chrome Web Store din 2024+ |
| Service Worker | Înlocuiește background page (MV2) |
| `chrome.storage.local` | Persistă config + queue offline |
| `chrome.runtime.sendMessage` | Communication content script ↔ SW |
| Native `fetch` | Comunicare cu web app |
| `tokens.css` + `i18n.js` | Paleta OKLCH din `@mmo/design-tokens` scopată pe `#mixai-download-btn` (nu pe `:root` al site-ului gazdă), RO/EN via `_locales` |

Fără bundler — vanilla JS direct. Dacă crește → migrăm la `vite` cu `@crxjs/vite-plugin`.

---

## ☁️ Infra (`infra/terraform/`)

| Componentă | De ce |
|---|---|
| **Terraform** | IaC declarativ, plan/apply previzibil |
| **GCP** vs AWS/Azure | Cea mai bună latență din EU pentru utilizatori RO; e2-micro free tier (când există), preț predictibil |
| **Coturn** | De facto standard pentru TURN; ușor de configurat REST ephemeral |
| **Debian 12** | Stabil, repo coturn actualizat |
| `random_password` resource | Generează `TURN_SHARED_SECRET` în Terraform state (encrypted) |

---

## 📦 Tooling cross-cutting

| Tool | Rol |
|---|---|
| **pnpm** | Package manager (workspaces, catalogs) |
| **pnpm-workspace.yaml** | Monorepo cu lockfile **per app** (`shared-workspace-lockfile=false`); `packages/*` consumate prin `tsconfig` `paths`, nu prin `workspace:` |
| **Turborepo** (TBD) | Task orchestration; încă nu — build-urile sunt serializate prin `run-build.ps1` |
| **GitHub Actions** | CI/CD — `companion-release.yml`, `native-release.yml`, `tv-android-release.yml`, `mmo-server-docker.yml`, `extension-ci.yml` |
| `scripts/measure-builds.ps1` | Măsurători de build per surface → [build-performance.md](build-performance.md) |
| **Conventional Commits** | Format mesaje commit |
| **VS Code** | Editor recomandat (settings + extensions partajate prin `.vscode/`) |

---

## 🚫 Ce NU folosim (și de ce)

| Tehnologie | De ce NU |
|---|---|
| **Prisma** | Codegen lent, schema-first DSL non-standard, migrare grea către alt ORM |
| **TanStack Query în RSC** | Server Components fac data fetching nativ; folosim TanStack Query doar în client components când e necesar |
| **Redux** | Zustand + RSC + URL state (nuqs) acoperă tot |
| **Pages Router** | App Router e standard de la Next 13 |
| **CSS Modules / styled-components / CSS-in-JS** | Tailwind v4 + tokens OKLCH acoperă tot, fără runtime; token-urile trebuie să ajungă și în Kotlin/CSS static pentru TV (ADR-0008) |
| **Radix / shadcn `radix-*`, `next-themes`** | Înlocuite de Base UI + ThemeProvider propriu (ADR-0008) |
| **Webpack** | Turbopack e default în Next 16; `@serwist/next` folosit în mod configurator tocmai ca să nu depindem de hook-ul webpack |
| **REST pentru mutări** | Server Actions (CSRF auto, type-safe) |
| **WebSockets** | SSE e suficient pentru one-way push (analyzer events, remote events); WebRTC pentru bidirectional audio |

---

## 🔗 Următorul pas

→ [04 — Fluxuri de date](04-fluxuri-date.md): cum circulă datele între componente.

---

[← 02](02-componente-suite.md) · [04 →](04-fluxuri-date.md)
