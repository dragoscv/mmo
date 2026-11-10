# MixAI public demo server — `demo.mixai.ro` (store review, WP16-53 / D39)

An always-on MMO Server with a legal library (Blender open movies, a public-domain series, CC-BY music
and two looping "live" channels) so App Store and Google Play reviewers can try every screen of the
apps without owning a server. Owner-approved always-on VM: it has **no** server-side deadline on purpose.

| Item | Value |
|---|---|
| Project / zone | `mmo-mw-prod` / `europe-central2-a` |
| VM | `mixai-demo`, e2-small (2 vCPU shared, 2 GB) + 2 GB swap, Debian 12, Shielded VM |
| Disks | boot 30 GB pd-balanced; `mixai-demo-data` 50 GB pd-balanced at `/srv/mixai` (`auto-delete=no`) |
| IP | static `mixai-demo-ip` = **34.118.46.71** |
| Firewall | `mixai-demo-web` tcp:80,443 only (17899 is never public; ssh = project default rule) |
| Labels | `purpose=store-review-demo,owner=mixai` |
| Service account | `mixai-demo@mmo-mw-prod` — AR reader on `mixai`, log + metric writer |
| Image | `europe-west1-docker.pkg.dev/mmo-mw-prod/mixai/mmo-server:<server version>-<sha>` (amd64) |
| Hostnames | `demo.mixai.ro` (Cloudflare A, DNS-only), `34-118-46-71.sslip.io` and `34-118-46-71.nip.io` (both work before mixai.ro DNS; the owner's home router rewrites `*.sslip.io` to 81.196.9.130, so the Live TV channels use the nip.io name since 2026-11-05) |

**DNS live 2026-11-05 22:43Z**: registrar NS → Cloudflare; `https://demo.mixai.ro` serves a Let's Encrypt cert
(Caddy had backed off after SERVFAIL — `docker compose restart caddy` retried at once). `deploy.ps1` re-run from a
clean tree @217a6fbf: `DEMO_HOST=demo.mixai.ro`, M3U/XMLTV + Live TV source on demo.mixai.ro (2 ch, 527 programmes).

**Live state (verified 2026-11-05 ~15:20Z, image `mmo-server:3.9.4-31fb136b`)**: `https://34-118-46-71.sslip.io`
answers with a Let's Encrypt cert; `demo.mixai.ro` has its A record in Cloudflare but the zone is not yet
delegated (registrar NS switch pending) — Caddy obtains its certificate automatically once it resolves, then
re-run `deploy.ps1` + setup so the M3U/XMLTV/Live TV source switch to `demo.mixai.ro`.

## Layout on the VM

```
/srv/mixai/app      compose.yaml Caddyfile loop.sh gen-epg.mjs setup.mjs content.sh .env demo.env(0600)
/srv/mixai/media    films/ shows/ music/ ATTRIBUTION.md   (read-only into the server)
/srv/mixai/data     server state (config.json, library.db, media.sqlite)
/srv/mixai/channel  www/{1,2}/index.m3u8 + demo.m3u + epg.xml   (served by Caddy at /demo-channel/)
/srv/mixai/caddy    ACME account + certificates
```

Containers (`docker compose`, host network): `mmo-server` (`MMO_DEMO=1`), `caddy` (TLS + reverse proxy),
`demo-channel-1|2` (`ffmpeg -re -stream_loop -1 -c copy -f hls`, no re-encode), `demo-epg` (48 h XMLTV every 6 h).

## Demo mode (`MMO_DEMO=1`, server ≥ 3.9.2, `server/src/demo.ts`)

- Quick Connect requests are approved immediately: the first `/pair/poll` returns the device token.
- Every client that comes through Caddy (has `X-Forwarded-For`) is a **viewer**: browse, play, progress,
  watchlist, bookmarks, Watch Together, favourites work; library/folder/Live TV source/profile admin,
  `/fs`, `/logs`, `/folders` and Subsonic `create*/update*/delete*` answer `403 demo_read_only`.
- Admin = direct loopback on the VM (`sudo docker exec -i mmo-server node - < setup.mjs`).
- Profiles: `Reviewer` (adult, no PIN), `Kids` (max age 12, no PIN) and `Parent` (adult, PIN `1234` — public on
    purpose, it is in the store review notes so reviewers can see the lock and the PIN pad; five wrong tries lock that
    profile for five minutes for everyone).

## Runbook

```powershell
# 1. VM, IP, firewall, SA, data disk (idempotent)
pwsh -NoProfile -File infra/demo/vm.ps1
# 2. Image: commit + push, then build/push amd64 from a CLEAN tree
pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\deploy-clean.ps1" -Target demo-image -Command 'pwsh -NoProfile -File infra/demo/image.ps1'
# 3. Stack + secrets (TMDB key copied from Secret Manager into demo.env, never printed)
pwsh -NoProfile -File infra/demo/deploy.ps1 -Image <tag printed by image.ps1>
# 4. Content (on the VM, ~5.6 GB, idempotent) then configuration
gcloud compute ssh mixai-demo --zone europe-central2-a --project mmo-mw-prod --command 'cd /srv/mixai/app && sudo bash content.sh'
gcloud compute ssh mixai-demo --zone europe-central2-a --project mmo-mw-prod --command 'cd /srv/mixai/app && . ./.env && sudo docker exec -i -e DEMO_HOST=$DEMO_HOST mmo-server node - < setup.mjs'
# 5. Live verification from a PC (pairs like an app; token saved to .copilot-tmp/demo/token.txt, never printed)
node .copilot-tmp/demo/pair.mjs https://demo.mixai.ro
```

Update the server: rebuild the image (step 2) then `deploy.ps1 -Image <new tag>`; data and content stay on
the data disk. Logs: `sudo docker logs --tail 100 mmo-server` / `caddy`.

## Cost estimate (europe-central2, list prices, Nov 2026)

| Resource | Monthly |
|---|---|
| e2-small always-on (730 h, incl. sustained-use pricing) | ~15.9 USD |
| 30 GB pd-balanced boot | ~3.6 USD |
| 50 GB pd-balanced data | ~6.0 USD |
| Static IPv4 in use | ~3.7 USD |
| Egress (reviewers stream a few GB/month, premium tier ~0.12 USD/GB) | ~1-3 USD |
| Artifact Registry storage (~0.5 GB image) | ~0.05 USD |
| **Total** | **~30-32 USD ≈ 28-30 EUR/month** |

The owner chose this exact shape (e2-small + 30/50 GB balanced) on 2026-11-05 over cheaper options
(e2-micro free tier ~5 EUR, pd-standard data ~19 EUR). Cheaper later: switch the data disk to
pd-standard (−4 USD) or the boot disk to 10 GB (−2.4 USD).

## Teardown (irreversible for content/state; ask the owner first)

`gcloud compute instances delete mixai-demo`, `disks delete mixai-demo-data`, `addresses delete mixai-demo-ip --region europe-central2`,
`firewall-rules delete mixai-demo-web`, `iam service-accounts delete mixai-demo@mmo-mw-prod.iam.gserviceaccount.com`,
Cloudflare record `demo`.
