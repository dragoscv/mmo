# Cloudflare Tunnel setup (per-device fast path)

The browser at `https://muzicai.ro` cannot talk to a companion at
`http://192.168.x.x:17899` directly — mixed-content + Private Network
Access kill it. Instead we give every paired device its own named
Cloudflare Tunnel: the companion runs `cloudflared --token …` which
opens an outbound QUIC connection to the Cloudflare edge; the browser
fetches `https://device-<id>.muzicai.ro` which the edge proxies
back through the tunnel to the companion's local Express port.

> **Use a flat (single-level) subdomain.** Cloudflare's free Universal
> SSL certificate covers only `muzicai.ro` and `*.muzicai.ro` — it does
> NOT cover `*.devices.muzicai.ro`. Two-level subdomains require a
> paid Advanced Certificate. We therefore use `device-<id>.muzicai.ro`
> (flat) instead of `device-<id>.devices.muzicai.ro` (nested). The
> `device-` prefix keeps these hostnames out of the way of `www`,
> `api`, etc.

End-to-end ~30–80 ms anywhere on the planet. Real HTTPS, no LAN games,
no NAT punching. Falls back gracefully to the announce queue when CF
isn't configured.

## One-time setup (production)

These steps are required ONCE on your Cloudflare account, then every
device that pairs gets its own tunnel automatically (provisioned by the
web app's announce route on first heartbeat).

### 1 · Move `muzicai.ro` DNS to Cloudflare (free)

Cloudflare's free plan does **not** support subdomain-only zones — that
needs Business ($200/mo). The clean and free path is to move the whole
domain's nameservers from Vercel to Cloudflare. Vercel hosting keeps
working unchanged; only DNS authority moves.

> **Before you start**: open Vercel → Domains → `muzicai.ro` → **DNS
> Records** and screenshot / export every single record (A, CNAME, MX,
> TXT, etc.). You must recreate every one in Cloudflare before flipping
> nameservers, or email + preview deploys break.

1. <https://dash.cloudflare.com> → **Add a domain** → `muzicai.ro` →
   **Free** plan.
2. Cloudflare auto-scans your current DNS and imports most records.
   **Cross-check the imported list against your Vercel export.** CF
   sometimes misses TXT records (SPF, DKIM, `_vercel` verification).
   Add anything missing manually.
3. For each record that points at Vercel (`A @ 76.76.21.21`,
   `CNAME www cname.vercel-dns.com`), set the proxy status to
   **DNS-only** (grey cloud, NOT orange). Vercel needs the real client
   IP and does its own TLS — proxying through CF would double-proxy.
4. CF shows you two nameservers, e.g.
   `ada.ns.cloudflare.com` + `bob.ns.cloudflare.com`. Copy them.
5. Go to your domain registrar (where you bought `muzicai.ro` — Hostico,
   ROTLD, Namecheap, etc.). Find the nameserver setting for the domain.
   Replace Vercel's `ns1.vercel-dns.com` / `ns2.vercel-dns.com` with
   the two Cloudflare ones. Save.
6. Wait 5 min – 24 h (usually under 1 h for `.ro`) for propagation. CF
   emails you when the zone status flips to **Active**.
7. Verify nothing broke:
   ```powershell
   nslookup muzicai.ro 1.1.1.1
   nslookup www.muzicai.ro 1.1.1.1
   ```
   Both should resolve to Vercel's IP. Open <https://muzicai.ro> in a
   private window — the site should load normally.

**Rollback**: if anything breaks, change nameservers back to
`ns1.vercel-dns.com` + `ns2.vercel-dns.com` at the registrar.
Propagation takes 5–60 min.

> No separate zone is needed. The per-device hostnames
> (`device-<id>.muzicai.ro`) are just CNAMEs under the apex
> `muzicai.ro` zone, auto-created by the API on first heartbeat.

### 2 · Create a scoped API token

1. Cloudflare dashboard → top-right profile menu → **API Tokens** →
   **Create Token** → **Custom token**.
2. Name: `MMO Tunnel Provisioner`.
3. **Permissions**:
   - `Account` → `Cloudflare Tunnel` → **Edit**
   - `Zone` → `DNS` → **Edit**
4. **Account Resources**: include your own account.
5. **Zone Resources**: include **only** `muzicai.ro`.
6. (Optional) TTL: leave blank for indefinite, or set 1 year.
7. **Continue to summary** → **Create Token** → copy the token. You
   only see it once.

### 3 · Find the two IDs

- **Account ID** — dashboard home → right sidebar.
- **Zone ID** — open `muzicai.ro` zone → right sidebar.

### 4 · Set environment variables

Add to **both** `app/.env.local` (for local dev) and Vercel
(Production + Preview):

```bash
CLOUDFLARE_API_TOKEN=...           # the token from step 2
CLOUDFLARE_ACCOUNT_ID=...          # from step 3
CLOUDFLARE_TUNNEL_ZONE_ID=...      # from step 3 (the muzicai.ro zone ID)
CLOUDFLARE_TUNNEL_BASE_HOSTNAME=muzicai.ro
```

`CLOUDFLARE_TUNNEL_BASE_HOSTNAME` is just the suffix used to compose
`device-<id>.muzicai.ro`. Use the apex (single-level) so the existing
free `*.muzicai.ro` cert covers it — nesting under `devices.muzicai.ro`
requires a paid Advanced Certificate.

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
