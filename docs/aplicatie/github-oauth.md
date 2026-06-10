# GitHub – integrare snapshot-uri (mirror de versionare)

> Aceasta pagină explică cum conectezi un cont GitHub la MMO ca să
> oglindești istoria proiectelor tale într-un repo privat numit
> `mmo-projects`. Funcția este *opțională* – snapshot-urile funcționează
> și fără ea (rămân doar în Postgres + GCS).

## Ce câștigi

- Fiecare snapshot manual sau auto devine un **commit Git** într-un
  repo privat `mmo-projects` din contul tău GitHub.
- Layout:
  ```
  projects/
    daw/<projectId>/project.json
    editor/<projectId>/project.json
    mixer/<projectId>/project.json
    live/<projectId>/project.json
  assets/<sha256>.bin
  ```
- Poți să clonezi repo-ul oricând și să-ți recuperezi proiectele chiar
  dacă pierzi accesul la cont sau la serverul nostru.
- Branch / merge / `git log` – cu uneltele standard Git.

## Pași pentru deploy / setup OAuth

### 1. Creează un OAuth App pe GitHub

1. Mergi la https://github.com/settings/developers → **New OAuth App**.
2. Completează:
   - **Application name**: `MMO` (sau ce vrei)
   - **Homepage URL**: `https://<domeniul-tău>` (sau `http://localhost:3000` pentru dev)
   - **Authorization callback URL**: `https://<domeniul-tău>/api/auth/callback/github`
     - Local: `http://localhost:3000/api/auth/callback/github`
3. **Generate a new client secret**, copiază secretul.

### 2. Setează variabilele de mediu

În `app/.env.local` (dev) sau în Vercel project settings (prod):

```dotenv
AUTH_GITHUB_ID=<client_id>
AUTH_GITHUB_SECRET=<client_secret>

# Cheie 32 bytes base64 pentru a cripta token-urile OAuth la rest:
#   node -e "console.log(crypto.randomBytes(32).toString('base64'))"
AUTH_TOKEN_ENC_KEY=<base64-32-bytes>
```

⚠️ **`AUTH_TOKEN_ENC_KEY` este OBLIGATORIU în producție.** Token-urile
OAuth de la GitHub sunt criptate cu AES-GCM în coloana
`user_oauth_tokens.access_token_enc`. În dev se folosește o cheie
efemeră dacă lipsește, dar restart-urile invalidează datele.

### 3. Aplică migrația

Migrația `0018_projects_normalized.sql` creează tabela
`user_oauth_tokens`. Rulează:

```bash
cd app && pnpm db:migrate
```

### 4. Conectează contul

1. Loghează-te în MMO (cu Google – contul "principal").
2. Mergi la **Settings → GitHub** (`/settings/github`).
3. Click **Connect GitHub** – te redirecționează la GitHub, accepți
   scope-ul `repo`.
4. La prima salvare de snapshot:
   - Aplicația încearcă să creeze repo-ul `<github-login>/mmo-projects`
     dacă nu există (privat).
   - Apoi face PUT pe `projects/<kind>/<externalId>/project.json` și
     pe asset-urile referite (`assets/<sha256>.bin`).
   - SHA-ul commit-ului ajunge în `project_snapshots.git_commit_sha`.

## Cum funcționează intern

- `app/src/lib/git/github.ts` – wrapper peste `@octokit/rest`.
- `app/src/lib/token-crypto.ts` – AES-GCM via `webcrypto.subtle`.
- `app/src/auth.ts` – provider `GitHub` cu `scope: "read:user repo"`
  și un `events.linkAccount` care upsertează token-ul criptat.
- `app/src/actions/projects.ts → createSnapshot` – apelează
  `commitSnapshot(...)` cu `try/catch` – dacă GitHub e indisponibil sau
  user-ul nu e conectat, snapshot-ul se salvează oricum în Postgres.

## Revocare

- **Dezactivează din UI**: Settings → GitHub → Disconnect.
- **Revocă scope-ul din GitHub**:
  https://github.com/settings/applications

## Limitări cunoscute

- Repo-ul e mereu privat și se numește mereu `mmo-projects`. Nu poți
  alege alt nume (deocamdată).
- Nu se face `git pull` din repo către aplicație – fluxul e doar
  push (write-only mirror).
- Asset-urile mari (>100 MB / 100 MB GitHub limit) sunt skipate.
- Rate limit: 5000 req/oră per token. Suficient pentru zeci de
  snapshot-uri pe oră.

## Vezi și

- [Snapshot-uri și storage tiers](./snapshots-storage.md) (TODO)
- [`infra/yjs-relay/README.md`](../../infra/yjs-relay/README.md) –
  colaborare în timp real
