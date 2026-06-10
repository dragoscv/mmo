# MMO Yjs Relay

Cloudflare Worker + Durable Objects implementing the y-websocket
protocol for real-time collaboration on MMO project documents.

## Deploy

```sh
pnpm install
# one-time: create R2 bucket for snapshots
pnpm exec wrangler r2 bucket create mmo-yjs-snapshots
pnpm exec wrangler deploy
```

The web app reads `NEXT_PUBLIC_YJS_RELAY_URL` to find this worker.
Set it to `wss://mmo-yjs-relay.<your-subdomain>.workers.dev`.

Each Yjs room name (`mmo:{kind}:{externalId}`) becomes one Durable
Object instance. Snapshots flush to R2 every 60s.

> Vercel Edge Functions can't host long-lived WebSockets, which is
> why this lives in Cloudflare. Companion's `/yjs` path works the
> same way for LAN/offline collab — see `server/src/collab/yjs-ws.ts`.
