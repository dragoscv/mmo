# @mmo/gateway — MuzicAI Companion Gateway

Hono service on **GCP Cloud Run** that owns the companion **control plane**,
keeping the chatty device heartbeat + command channel off the Vercel (web app)
serverless hot path.

## Why

Previously the Electron companion posted its heartbeat directly to the Next.js
app on Vercel (`muzicai.ro/api/devices/announce`) every ~10s. On a bursty
serverless platform that caused cold-start timeouts (`AbortError`) and stale
`last_seen_at`, which surfaced as the analyzer modal getting stuck on
"Reconnecting to companion…". A dedicated long-lived service is the correct
home for a control plane.

## What it does

| Surface | Path | Purpose |
| --- | --- | --- |
| HTTP | `GET /health` | Liveness (NOT `/healthz` — reserved by Google Frontend) |
| HTTP | `POST /api/devices/announce` | Heartbeat + command channel (wire-compatible with the legacy web route) |
| WS | `/ws` | Persistent heartbeat + command channel — a live socket means `online`; disconnect flips the device `offline` instantly |

It reuses the **same Postgres** (`DATABASE_URL`) and **same `AUTH_SECRET`** as
the web app, so device tokens issued by either side resolve on both. It declares
only the control-plane schema slice (`devices`, `device_commands`); `apps/web`
remains the single owner of migrations.

## Architecture

```
companion (Electron)
   │  HTTP announce / WS heartbeat  (control plane)
   ▼
api gateway (Hono, Cloud Run)  ──►  Postgres (shared)
                                    Cloudflare tunnel provisioning

browser (muzicai.ro on Vercel)
   │  data plane: /api/sync, library, audio  (unchanged — Phase 2 will move sync)
   ▼
Next.js app (Vercel)  ──►  same Postgres
   │  browser → companion via per-device Cloudflare tunnel (device-*.muzicai.ro)
```

## Local dev

```pwsh
pnpm install
node --env-file=../web/.env.local dist/server.js   # or: pnpm dev
```

## Deploy

```pwsh
pwsh deploy.ps1                 # Cloud Build + Cloud Run (project mmo-mw-prod, europe-west4)
pwsh deploy.ps1 -SkipBuild      # redeploy current image
```

Live: `https://muzicai-gateway-f2aflobeva-ez.a.run.app`
(custom domain `api.muzicai.ro` pending domain verification / Host-header rule).

## Roadmap

- **Phase 2**: move the `/api/sync` data plane here, reusing a shared
  `packages/db`. (Sync is ~1500 lines of LWW conflict logic on live user data —
  migrated in its own verified pass.)
- Companion WebSocket client (currently the companion uses the HTTP announce
  path against the gateway; the WS endpoint is live and tested).
- Map `api.muzicai.ro` once the zone is verified for the GCP account or a
  Cloudflare Origin Rule (Host override) is permitted by the API token.
