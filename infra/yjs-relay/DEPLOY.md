# Deploy guide – Cloudflare Workers Yjs relay

Acest ghid descrie deploy-ul pas-cu-pas al relay-ului Yjs din
`infra/yjs-relay/` și un workflow GitHub Actions pentru CI/CD.

## De ce Cloudflare?

Vercel Edge nu poate ține WebSocket-uri lungi (>30s). Cloudflare
Workers + Durable Objects oferă exact ce ne trebuie:

- O instanță Durable Object per cameră `mmo:{kind}:{externalId}` →
  serializare naturală a update-urilor.
- R2 ca storage ieftin pentru snapshot-urile Yjs (flush la fiecare
  60s).
- Bandwidth gratuit pentru WS între utilizatori Cloudflare.

## Prerequisite

1. Cont Cloudflare (free tier e suficient pentru beta).
2. `wrangler` CLI: vine ca dependență dev a pachetului
   `infra/yjs-relay/`.
3. Node ≥ 20 + pnpm ≥ 10.

## Pași manuali (one-time)

```bash
cd infra/yjs-relay
pnpm install

# 1) Autentifică-te în Cloudflare:
pnpm exec wrangler login

# 2) Creează bucket-ul R2 pentru snapshot-uri:
pnpm exec wrangler r2 bucket create mmo-yjs-snapshots

# 3) Deploy:
pnpm exec wrangler deploy
```

Wrangler îți va răspunde cu un URL `https://mmo-yjs-relay.<subdomain>.workers.dev`.

În `app/.env.local` (sau Vercel env):

```dotenv
NEXT_PUBLIC_YJS_RELAY_URL=wss://mmo-yjs-relay.<subdomain>.workers.dev
```

## Configurare custom domain (opțional)

În dashboard Cloudflare → Workers & Pages → `mmo-yjs-relay` → Settings
→ Triggers → Add Custom Domain:
- `yjs.exemplul-tău.com` → roută către worker.

Apoi: `NEXT_PUBLIC_YJS_RELAY_URL=wss://yjs.exemplul-tău.com`.

## Secrets pentru CI/CD

Pentru workflow-ul de mai jos, configurează în GitHub repo settings →
Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` – generează la
  https://dash.cloudflare.com/profile/api-tokens → **Edit Cloudflare
  Workers** template.
- `CLOUDFLARE_ACCOUNT_ID` – în dashboard, sidebar dreapta.

## GitHub Actions workflow

Fișierul `.github/workflows/yjs-relay-deploy.yml` rulează `wrangler
deploy` automat la fiecare push pe `main` care atinge
`infra/yjs-relay/**`. Vezi acel fișier pentru sursă.

## Testare locală

```bash
cd infra/yjs-relay
pnpm exec wrangler dev
```

Pornește un server pe `localhost:8787`. În `app/.env.local`:

```dotenv
NEXT_PUBLIC_YJS_RELAY_URL=ws://localhost:8787
```

Apoi deschide aceeași pagină (DAW / Editor / Mixer / Live) în 2
browsere și verifică avatarurile presence + cursor-urile.

## Monitorizare

- **Logs**: `pnpm exec wrangler tail`
- **R2 snapshot size**: în dashboard → R2 → `mmo-yjs-snapshots`.
- **DO storage**: în dashboard → Workers & Pages →
  `mmo-yjs-relay` → Durable Objects.

## Costuri estimate

- Free tier: 100k requests / zi, 10 GB R2 storage gratis.
- Beta cu sub 100 utilizatori activi: ~zero.
- Producție 1000 utilizatori activi: <10$/lună.

## Rollback

Wrangler păstrează istoria deploy-urilor:

```bash
pnpm exec wrangler deployments list
pnpm exec wrangler rollback <deployment-id>
```
