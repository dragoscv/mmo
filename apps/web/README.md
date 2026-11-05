# 🌐 Web App — Setup pentru dezvoltatori

> Setup, comenzi și convenții pentru lucrul la **MMO Web App** (`apps/web/`).
> Pentru ghiduri user → [`docs/aplicatie/`](../docs/aplicatie/).
> Pentru arhitectură → [`docs/arhitectura/`](../docs/arhitectura/).

[🏠 Home](../README.md) · [🇬🇧 EN README](../README.en.md)

---

## ⚡ Quick start

```bash
cd apps/web
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
apps/web/
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

> ⚠️ `apps/web/.env.example` lipsește momentan — TBD.

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

## ☁️ Cloud Run

Producția web rulează pe **Cloud Run `mixai-web`** (proiect `mmo-mw-prod`, `europe-west1`, lângă Cloud SQL
`mmo-pg`). Vercel (`codai-ro/mmo`) este dezactivat din 2026-11.

- Imagine: `apps/web/Dockerfile` (context = rădăcina repo-ului, Next `output: standalone` prin
	`NEXT_OUTPUT_STANDALONE=1`, node 22, user non-root, port 8080), build prin `apps/web/cloudbuild.yaml`
	în Artifact Registry `europe-west1-docker.pkg.dev/mmo-mw-prod/mixai/mixai-web:<sha12>`.
- Deploy (doar din arbore curat, commit împins):
	`pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\deploy-clean.ps1" -Command 'pwsh -NoProfile -File apps/web/scripts/deploy-cloud-run.ps1'`
	Opțiuni: `-AppUrl` (implicit `https://mixai.ro`), `-NoSecretSync`, `-SkipBuild`.
- Migrații: NU rulează la deploy. Verifică întâi `pnpm -C apps/web db:status` (`.env.local` = PROD).
- DB: socket Cloud SQL (`--add-cloudsql-instances`, `DB_SOCKET_DIR=/cloudsql/mmo-mw-prod:europe-west1:mmo-pg`);
	user/parolă/db din `DATABASE_URL`. Pool 4 conexiuni/instanță (`DB_POOL_MAX`), max 4 instanțe.
- Runtime SA: `mmo-web-app@mmo-mw-prod.iam.gserviceaccount.com` (secretAccessor, cloudsql.client, storage).
- Secret Manager (sincronizate din `.env.local`, valori niciodată afișate; doar cele nevide se montează):
	`mixai-web-database-url`, `mixai-web-auth-secret`, `mixai-web-auth-token-enc-key`,
	`mixai-web-auth-google-id`, `mixai-web-auth-google-secret`, `mixai-web-auth-github-id`,
	`mixai-web-auth-github-secret`, `mixai-web-stripe-secret-key`, `mixai-web-stripe-webhook-secret`,
	`mixai-web-tmdb-api-key`, `mixai-web-tmdb-read-token`, `mixai-web-azure-openai-key`,
	`mixai-web-azure-speech-key`, `mixai-web-azure-client-secret`, `mixai-web-cloudflare-api-token`,
	`mixai-web-mmo-trainer-secret`, `mixai-web-revalidate-secret`, `mixai-web-turn-shared-secret`,
	`mixai-web-appinsights-connection-string`, `mixai-web-gcp-service-account-key`.
- Secrete opționale, doar în Secret Manager (montate numai dacă au o versiune activă; fără ele funcția e oprită):
	`mixai-web-apple-services-id`, `mixai-web-apple-key-id`, `mixai-web-apple-p8` (Sign in with Apple),
	`mixai-web-auth-apple-secret` (JWT gata făcut, alternativ), `mixai-web-apns-key-id`, `mixai-web-apns-p8` (push iOS),
	`mixai-web-fcm-sa` (push Android). Pași: [`docs/followups/apple-siwa-setup.md`](../../docs/followups/apple-siwa-setup.md).
- Push (`/api/push/*`) cere migrarea `drizzle/0031_push_tokens.sql`; până e aplicată rutele răspund
	`503 push_unavailable`, restul aplicației merge normal.
- `AUTH_URL`/`NEXTAUTH_URL`/`MMO_APP_URL` = `https://mixai.ro` (live din 2026-11-05, rev `mixai-web-00010-7bd`).
	URL-ul run.app servește aceeași aplicație (fără redirect — build-urile mobile 1.1.0 îl folosesc).
	Google OAuth (client `Web client 1`, mmo-mw-prod): redirect URI `<origin>/api/auth/callback/google` pentru
	mixai.ro, www.mixai.ro și run.app — fără el login-ul Google dă `redirect_uri_mismatch`.
- Domeniu `mixai.ro` (configurat 2026-11-05, DNS în Cloudflare prin `scripts/cloudflare-dns-mixai.ps1`):
	Cloud Run domain mapping (europe-west1 suportă) →
	`gcloud beta run domain-mappings create --service mixai-web --domain mixai.ro --region europe-west1 --project mmo-mw-prod`
	(necesită domeniul verificat pentru contul gcloud — la 2026-11-05 `mixai.ro` NU era în
	`gcloud domains list-user-verified`; `gcloud domains verify mixai.ro` → TXT `google-site-verification=…` în
	Cloudflare), apoi în Cloudflare înregistrările
	A/AAAA afișate de comandă (apex) sau `CNAME www → ghs.googlehosted.com.`, **DNS only** (proxy gri) până
	emite Google certificatul. Alternativ: Cloudflare proxy + Load Balancer — nu e configurat.
- `public/samples` (934 MB) NU este în imagine; mostrele DAW trebuie mutate în GCS.

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
