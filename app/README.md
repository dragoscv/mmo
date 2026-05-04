# 🌐 Web App — Setup pentru dezvoltatori

> Setup, comenzi și convenții pentru lucrul la **MMO Web App** (`app/`).
> Pentru ghiduri user → [`docs/aplicatie/`](../docs/aplicatie/).
> Pentru arhitectură → [`docs/arhitectura/`](../docs/arhitectura/).

[🏠 Home](../README.md) · [🇬🇧 EN README](../README.en.md)

---

## ⚡ Quick start

```bash
cd app
pnpm install
cp .env.example .env.local         # editează secretele (vezi mai jos)
pnpm db:generate                    # generează migrations din schema Drizzle
pnpm db:migrate                     # aplică migrations pe SQLite local
pnpm dev                            # → http://localhost:3000
```

> Cerințe: **Node ≥22**, **pnpm ≥9**.

---

## 📦 Scripts

| Script | Ce face |
|--------|---------|
| `pnpm dev` | Dev server cu Turbopack pe `localhost:3000` |
| `pnpm build` | Build producție (Next.js + RSC) |
| `pnpm start` | Servește build-ul de producție |
| `pnpm typecheck` | `tsc --noEmit` (verifică tipurile) |
| `pnpm db:generate` | Generează SQL migrations din `src/db/schema.ts` |
| `pnpm db:migrate` | Aplică migrations pe DB |
| `pnpm db:studio` | Drizzle Studio — UI vizual pentru DB |

---

## 🗂️ Structura

```
app/
├── src/
│   ├── app/                    Next.js App Router
│   │   ├── (rute)/             ~17 rute publice (library, mixer, daw, etc.)
│   │   ├── api/                ~35 endpoints REST/SSE
│   │   ├── globals.css         Tailwind v4 entry + custom properties
│   │   ├── layout.tsx          Root layout (Auth provider, theme)
│   │   └── page.tsx            Dashboard
│   ├── actions/                17 Server Actions (mutații + queries server-side)
│   ├── components/             80+ componente UI
│   │   ├── daw/                Timeline editor
│   │   ├── editor/             Sound editor
│   │   ├── live/               Live performance UI
│   │   ├── remote/             WebRTC bridge UI
│   │   ├── settings/           Settings forms
│   │   ├── sidebar/            Navigation sidebar
│   │   └── ui/                 shadcn/ui primitives
│   ├── db/
│   │   ├── schema.ts           Drizzle schema (13 tabele)
│   │   └── index.ts            DB client
│   ├── hooks/                  React hooks custom
│   ├── lib/                    34 utilități & engines
│   │   ├── audio*              Audio engines (FX, EQ, mixer, daw, live, stems)
│   │   ├── webrtc-*            Remote collaboration
│   │   ├── controllers/        MIDI controller mappings
│   │   ├── dev-debugger/       Dev console & profiler
│   │   └── visualizations/     Shaders & FFT
│   ├── auth.ts                 Auth.js v5 config
│   └── proxy.ts                Replaces middleware.ts (Next 16)
├── public/
│   ├── samples/                Sample pack pentru DAW
│   ├── worklets/               AudioWorklet processors
│   ├── manifest.webmanifest    PWA manifest
│   └── sw.js                   Service worker
├── drizzle/                    Migrations generate
├── data/                       Local data (downloads, cache)
│   └── downloads/              Default download dir
├── scripts/                    Build scripts (sample pack, etc.)
├── components.json             shadcn config
├── drizzle.config.ts           Drizzle Kit config
├── next.config.ts              Next.js config (RC, Turbopack opts)
├── postcss.config.mjs          Tailwind v4 PostCSS plugin
└── tsconfig.json               TypeScript strict mode
```

---

## 🔐 Variabile de mediu

> ⚠️ `app/.env.example` lipsește momentan — TBD.

Variabile minim necesare pentru dev:

```bash
# Auth.js v5
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<generate cu: openssl rand -base64 32>

# Auth provider (cel puțin unul)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# sau GITHUB_ID / GITHUB_SECRET, etc.

# DB
DATABASE_URL=./data/dev.sqlite        # dev (default)
# DATABASE_URL=postgres://...         # prod

# Companion download API (opțional — evită rate limit GitHub)
GITHUB_TOKEN=                          # token cu scope public_repo
COMPANION_REPO_OWNER=dragoscv          # default
COMPANION_REPO_NAME=mmo                # default

# WebRTC TURN (opțional pentru remote)
TURN_HOST=                             # ex: 35.x.x.x (din Terraform output)
TURN_SHARED_SECRET=                    # din Terraform output
```

---

## 🛠️ Stack pe scurt

- **Next.js 16** (App Router, RSC, Server Actions, Turbopack default, React Compiler)
- **React 19.2** + **TypeScript 5.8** strict
- **Drizzle ORM** + **better-sqlite3** (dev) / Postgres (prod)
- **Auth.js v5** (next-auth beta) + Drizzle adapter
- **Tailwind CSS v4** + **shadcn/ui** + Radix
- **Audio**: music-metadata, node-id3, Web Audio API + AudioWorklet
- **Realtime**: Server-Sent Events + WebRTC (TURN opțional)

→ Detaliat: [`docs/arhitectura/03-stack-tehnologic.md`](../docs/arhitectura/03-stack-tehnologic.md)

---

## 🧩 Convenții cod

- **Server-first**: prefer RSC + Server Actions; `"use client"` doar la componente interactive
- **Mutări = Server Actions**, nu API routes (CSRF auto)
- **API routes** doar pentru: webhooks externe, audio streaming, SSE, clienți non-web (companion, extension)
- **Validare la border**: orice action / API începe cu `Zod` parse
- **Auth check first**: `const session = await auth(); if (!session?.user?.id) throw ...`
- **Drizzle queries**: `WHERE userId = session.user.id` în orice query (multi-tenancy)
- **Imports**: alias `@/...` pentru `src/...`
- **Components**: shadcn → `src/components/ui/`; feature → subfolder per modul

---

## 🐛 Troubleshooting

### Port 3000 ocupat
```bash
pnpm dev -- -p 3001
```

### DB locked (better-sqlite3)
Închide Drizzle Studio sau orice altă conexiune înainte de `pnpm db:migrate`.

### Companion 503 în consolă
Vezi [`docs/companion/`](../docs/companion/) — fie instalezi companion-ul, fie ignori (e doar warn, nu eroare).

### `[next-auth][error][JWT_SESSION_ERROR]`
Verifică `NEXTAUTH_SECRET` setat în `.env.local`.

---

## 🔗 Linkuri

- 🏠 [README principal](../README.md)
- 🏗️ [Arhitectură](../docs/arhitectura/)
- 📚 [Ghiduri user](../docs/aplicatie/)
- 🖥️ [Companion dev](../server/README.md)
- 🧩 [Extension dev](../extension/README.md)
