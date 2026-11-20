# MMO Server on Raspberry Pi 5 (homepi)

Headless build of `server/` (ADR-0002): plain Node 22, no Electron, no native
audio. Image: `ghcr.io/dragoscv/mmo-server` (linux/amd64 + linux/arm64), built
by `.github/workflows/mmo-server-docker.yml` on every `server-v*` tag.

## Deploy (one-liner)

```sh
ssh homepi 'sudo mkdir -p /srv/homepi/mmo /srv/homepi/compose && cd /srv/homepi/compose && curl -fsSL https://raw.githubusercontent.com/dragoscv/mmo/main/infra/pi/compose.mmo.yaml -o compose.mmo.yaml && docker compose -f compose.mmo.yaml pull && docker compose -f compose.mmo.yaml up -d && curl -s http://127.0.0.1:17899/health'
```

Optional Home Assistant creds: create `/srv/homepi/compose/.env` on the Pi with
`HA_URL=` and `HA_TOKEN=` (never commit it).

## Layout

| Path on Pi                | In container | Purpose                                   |
| ------------------------- | ------------ | ----------------------------------------- |
| `/srv/homepi/mmo`         | `/data`      | `config.json`, `library.db`, logs, thumbs |
| `/srv/media`              | `/media` (ro)| media library; `MMO_MEDIA` lists subfolders registered on first boot |

## Update

```sh
ssh homepi 'cd /srv/homepi/compose && docker compose -f compose.mmo.yaml pull && docker compose -f compose.mmo.yaml up -d'
```

## Local build (any arch)

```sh
docker build -f server/Dockerfile -t mmo-server:dev server
docker run --rm -p 17998:17899 -v mmo-data:/data mmo-server:dev
curl -s http://127.0.0.1:17998/health
```

## Notes

- Pi 5 has no hardware video encoder: direct play → remux → audio-only
  transcode. Full transcodes are a Companion (PC) feature.
- `/audio/native/probe` reports `available: false, reason: "native audio
  disabled (MMO_HEADLESS=1)"` — clients hide the low-latency engine.
- Folder picker routes (`/folders/pick`) return `canceled: true` headless;
  add folders via `MMO_MEDIA` or the settings API.
