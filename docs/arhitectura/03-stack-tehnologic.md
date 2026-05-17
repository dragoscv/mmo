# 03 — Stack tehnologic

> [← 02](02-componente-suite.md) · [04 →](04-fluxuri-date.md)

Toate dependențele majore din MMO, grupate pe componentă, cu **motivația** alegerii.

---

## 🌐 Web App (`app/package.json`)

### Framework & runtime

| Dependență | Versiune | De ce |
|---|---|---|
| `next` | 16.2.3 | App Router, RSC, Server Actions, Turbopack default, React Compiler |
| `react` / `react-dom` | 19.2.0 | View Transitions, `useEffectEvent`, `<Activity>`, compilator nou |
| `typescript` | 5.8.3 | Strict mode, `import defer` pentru module grele |
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
| `tailwindcss` 4.1 | CSS-first config (`@theme`), PostCSS plugin |
| `shadcn` 4.2 | Componente owned (Radix + CVA + tailwind-merge) |
| `@radix-ui/*` | Primitive headless accesibile |
| `class-variance-authority` 0.7 | Variants type-safe pentru componente |
| `clsx` + `tailwind-merge` | Combinare clase Tailwind sigură |
| `lucide-react` 1.8 | Iconuri SVG, tree-shakable |
| `next-themes` 0.4 | Dark mode |
| `sonner` 2.0 | Toast notifications |
| `cmdk` 1.1 | Command palette |
| `framer-motion` 12.38 | Animații (DAW timeline, transitions) |
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
| `@biomejs/biome` (TBD) | Linter/formatter rapid (sau ESLint flat config) |

---

## 🖥️ Companion (`server/package.json`)

| Dependență | De ce |
|---|---|
| `electron` | Cross-platform desktop app |
| `electron-builder` | Build DMG/EXE/AppImage + auto-update |
| `electron-updater` | Auto-update din GitHub Releases |
| `express` | HTTP server local (audio streaming, file API) |
| `chokidar` | Watch folders cross-platform |
| `music-metadata` | Extragere metadate (la fel ca în web app) |
| `electron-log` | Logging cross-platform |
| `electron-store` | Persistă config în `app.getPath('userData')` |

> **De ce Electron și nu Tauri?** Tauri e mai mic și mai sigur, dar comunitatea Electron + maturity electron-builder + auto-update sunt încă imbatabile pentru un app cu audio nativ și hardware MIDI. Vom reevalua când Tauri 3 stabilizează `tauri-plugin-shell` și `tauri-plugin-fs-watch`.

---

## 🧩 Extension (`apps/extension/manifest.json`)

| Tehnologie | De ce |
|---|---|
| **Manifest V3** | Cerință Chrome Web Store din 2024+ |
| Service Worker | Înlocuiește background page (MV2) |
| `chrome.storage.local` | Persistă config + queue offline |
| `chrome.runtime.sendMessage` | Communication content script ↔ SW |
| Native `fetch` | Comunicare cu web app |

Fără bundler — vanilla JS direct (3 fișiere mici). Dacă crește → migrăm la `vite` cu `@crxjs/vite-plugin`.

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
| **pnpm-workspace.yaml** | Monorepo (la nevoie); momentan `app/` și `server/` au lockfiles separate |
| **Turborepo** (TBD) | Task orchestration; util când vor fi 3+ packages |
| **GitHub Actions** | CI/CD — `companion-release.yml` build & publish |
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
| **CSS Modules / styled-components** | Tailwind v4 + shadcn acoperă tot, fără runtime |
| **Webpack** | Turbopack e default în Next 16 |
| **REST pentru mutări** | Server Actions (CSRF auto, type-safe) |
| **WebSockets** | SSE e suficient pentru one-way push (analyzer events, remote events); WebRTC pentru bidirectional audio |

---

## 🔗 Următorul pas

→ [04 — Fluxuri de date](04-fluxuri-date.md): cum circulă datele între componente.

---

[← 02](02-componente-suite.md) · [04 →](04-fluxuri-date.md)
