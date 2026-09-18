---
name: pi-deploy
description: Ship the MMO Server Docker image to the Raspberry Pi 5 (homepi) — build arm64 LOCALLY with buildx+QEMU, scp the tar, docker load, compose --force-recreate, then verify the live container. Never build on the Pi. Use when deploying server/ changes to the home server, when the Pi container runs an old image, or when the deploy script fails. Trigger words: pi deploy, homepi, arm64, buildx, mmo-server:local, compose.mmo.yaml, docker load.
---

# Deploy MMO Server to the Raspberry Pi

Hard rule (user): **never build on the Pi** — it is undervolted (`vcgencmd get_throttled` 0x50005) and slow.
Build here, ship the image. Scripts: `scripts/build-mmo-server-image.ps1`, `scripts/deploy-mmo-server-pi.ps1`;
compose file `infra/pi/compose.mmo.yaml`; data on the Pi `/srv/homepi/mmo`, media `/srv/media/{Movies,Music}`.
Measured: arm64 cold build 145 s, cached 5 s, deploy 62 s, image ~682 MB arm64.

## Procedure
1. Pre-flight (local): `pnpm -C server build:headless` green (skill `companion-verify`); Docker Desktop running
   with buildx + QEMU (`docker buildx ls` shows a builder with `linux/arm64`).
2. Pick the Pi address. `homepi` eth0 (`.232`) is FLAKY; wlan0 `192.168.100.63` is stable:
   `-Pi dragos@192.168.100.63` (ssh key auth already set up; never type passwords into the agent).
3. Build + ship + recreate in one go (hidden process, ~4 min cold):
   ```powershell
   pwsh -NoProfile -File E:\gh\mmo\scripts\deploy-mmo-server-pi.ps1 -Pi dragos@192.168.100.63 -Tag mmo-server:local
   ```
   Internally: `build-mmo-server-image.ps1 -Platforms linux/arm64 -Tag mmo-server:local -Out .copilot-tmp\mmo-server-arm64.tar`
   → `scp compose.mmo.yaml` + tar → `docker load -i` → `docker compose up -d --force-recreate`.
   `-SkipBuild` reuses the last tar. Output ends with `SHIP OK  <s>  (<MB> tar)`.
4. Build only (e.g. amd64 too): `pwsh -NoProfile -File scripts\build-mmo-server-image.ps1 -Platforms linux/amd64,linux/arm64 -Tag mmo-server:local [-Load|-Out x.tar]`.
   Cache dir `.copilot-tmp/buildx-cache` — keep it, it is what makes rebuilds 5 s.
5. Tag a release when the change is user-visible: bump `server/package.json` + `server/CHANGELOG.md`, tag
   `server-vX.Y.Z` → `mmo-server-docker.yml` builds the GHCR image (context `server/`).

## Verify (LIVE state, not the local diff)
```powershell
ssh dragos@192.168.100.63 "docker ps --format '{{.Names}} {{.Image}} {{.Status}}' ; docker image inspect mmo-server:local --format '{{.Id}} {{.Created}}'"
curl.exe -s http://192.168.100.63:17899/pair/info
```
- The container's `Image` id equals the freshly loaded id and `Created` is now; `pair/info` returns 200 JSON.
- Logs: `ssh … "docker logs --tail 50 <container>"` show the new version string.
- TVs discover it via mDNS `_mmo-companion._tcp` (`pair=1` TXT); Google TV `Discovery.kt`, Tizen sweeps the /24.

## Common failures
- Compose keeps running the OLD image after `docker load` → the tar was `--output type=oci` (loses `repo:tag`).
  The script uses `type=docker,dest=` + `--force-recreate`; if you hand-roll, do the same.
- 15-minute build → `npm_config_build_from_source` set; better-sqlite3 + audify ship arm64 prebuilds. Don't.
- `ERR_PNPM_IGNORED_BUILDS` fatal → Dockerfile must pin `pnpm@10.0.0` via corepack; copy `.npmrc` (hoisted).
- `--config.optional=false` breaks the frozen lockfile (register-scheme git dep) — don't add it.
- ssh timeouts / container restarts at random → Pi undervoltage, not software; needs the official 27 W PSU.
- Unpaired 401 after first deploy → no `config.json` yet in `/srv/homepi/mmo`; pair from web (`/pair`) or set
  `MMO_DEVICE_TOKEN` in the compose env.
- `docker load` "no space left" → prune old images on the Pi (`docker image prune -f`) — ask first, it is destructive.
