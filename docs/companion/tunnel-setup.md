# Cloudflare Tunnel setup (per-device fast path)

The browser at `https://muzicai.ro` cannot talk to a companion at
`http://192.168.x.x:17899` directly — mixed-content + Private Network
Access kill it. Instead we give every paired device its own named
Cloudflare Tunnel: the companion runs `cloudflared --token …` which
opens an outbound QUIC connection to the Cloudflare edge; the browser
fetches `https://device-<id>.devices.muzicai.ro` which the edge proxies
back through the tunnel to the companion's `localhost:17899`.

End-to-end ~30–80 ms anywhere on the planet. Real HTTPS, no LAN games,
no NAT punching. Falls back gracefully to the announce queue when CF
isn't configured.

## One-time setup (production)

These steps are required ONCE on your Cloudflare account, then every
device that pairs gets its own tunnel automatically (provisioned by the
web app's announce route on first heartbeat).

### 1 · Delegate `devices.muzicai.ro` to Cloudflare (free)

Cloudflare's free tier requires the zone to be hosted on their
nameservers, but you don't have to move your whole `muzicai.ro`. Just
delegate the subdomain:

1. Go to <https://dash.cloudflare.com> → **Add a domain** → enter
   `devices.muzicai.ro` → **Free** plan → **Continue**. CF will scan
   (find nothing) and give you **two nameservers**, e.g.
   `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`.
2. At your existing DNS provider for `muzicai.ro`, add two NS records:
   ```
   devices.muzicai.ro  NS  ada.ns.cloudflare.com
   devices.muzicai.ro  NS  bob.ns.cloudflare.com
   ```
   (use the exact nameservers Cloudflare gave you).
3. Wait 5–60 minutes for the delegation to propagate. Cloudflare emails
   you when the zone status flips to **Active**.

### 2 · Create a scoped API token

1. Cloudflare dashboard → top-right profile menu → **API Tokens** →
   **Create Token** → **Custom token**.
2. Name: `MMO Tunnel Provisioner`.
3. **Permissions**:
   - `Account` → `Cloudflare Tunnel` → **Edit**
   - `Zone` → `DNS` → **Edit`
4. **Account Resources**: include your own account.
5. **Zone Resources**: include **only** `devices.muzicai.ro`.
6. (Optional) TTL: leave blank for indefinite, or set 1 year.
7. **Continue to summary** → **Create Token** → copy the token. You
   only see it once.

### 3 · Find the two IDs

- **Account ID** — dashboard home → right sidebar.
- **Zone ID** — open `devices.muzicai.ro` → right sidebar.

### 4 · Set environment variables

Add to **both** `app/.env.local` (for local dev) and Vercel
(Production + Preview):

```bash
CLOUDFLARE_API_TOKEN=...           # the token from step 2
CLOUDFLARE_ACCOUNT_ID=...          # from step 3
CLOUDFLARE_TUNNEL_ZONE_ID=...      # from step 3
CLOUDFLARE_TUNNEL_BASE_HOSTNAME=devices.muzicai.ro
```

Redeploy the web app.

## How it works at runtime

1. **First heartbeat after deploy**: the announce route calls
   `ensureDeviceTunnel(deviceId)`. CF API creates a named tunnel + DNS
   record. Bootstrap (`{tunnelHostname, tunnelToken}`) is returned in
   the announce response.
2. **Companion**: persists the bootstrap to electron-store and spawns
   `cloudflared tunnel --no-autoupdate run` with `TUNNEL_TOKEN` in env.
   Cloudflared establishes a QUIC connection to the CF edge (~3–5 s).
3. **Subsequent heartbeats**: companion echoes `tunnelHostnameAck` so
   the server doesn't re-send the secret token every 3 s.
4. **Browser opens devices page**: calls `getDeviceDirectAccess()`
   once → caches `{hostname, bearer}` → uses `directFetch()` for
   `/fs/drives`, `/fs/list`, `/fs/add`. Falls back to the queue-based
   server actions on any failure.

## Fallback behavior

The companion + web app both work without Cloudflare configured:

- `getCloudflareConfig()` returns `null` when any env var is missing →
  `ensureDeviceTunnel()` returns `null` → announce responses carry
  `tunnelBootstrap: null` → companion never starts cloudflared.
- Browser calls `getDeviceDirectAccess()` → returns `null` → `fast*`
  helpers skip the tunnel branch and use the existing server actions.

This means partial rollouts are safe: deploy the web app + companion
v1.0.14, then complete CF setup at your leisure — devices auto-upgrade
to the fast path on their next heartbeat.

## Costs

- **Cloudflare Tunnel**: free (no traffic cap, no device cap).
- **DNS**: free (one CNAME per device).
- **CF API**: free.
- **Per-device installer size**: +~25 MB for the bundled `cloudflared`
  binary.

## Teardown

`removeDevice()` calls `destroyDeviceTunnel()` which deletes the tunnel
and the DNS record. Failures are non-fatal — orphan tunnels on the CF
account can be cleaned up manually from the dashboard under **Zero
Trust → Networks → Tunnels**.
