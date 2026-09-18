# MixAI TV — Samsung Tizen (.wgt)

Tizen web application for Samsung Smart Hub TVs/monitors (tested target: Odyssey OLED G8,
Tizen 7). Connects to **MMO Server** on the LAN (`http://<host>:17899`), browses movies and
music and plays them with the platform `<video>` element — progressive MP4 direct, HLS via
`hls.js` (lazy-loaded) for everything the server has to remux, WebVTT subtitles.

Standalone Vite + React 19 + TypeScript app; **no dependency on `apps/web`**. See
[ADR-0004](../../docs/adr/0004-tv-apps-compose-media3-and-tizen-web.md) and the Romanian
user guide in [`docs/aplicatie/tv-tizen.md`](../../docs/aplicatie/tv-tizen.md).

## Layout

```
config.xml              Tizen widget manifest (id http://mixai.ro/tv, app mXa1TvApp0.MixAI)
index.html              <html data-tv data-mode="dark" …>, seeds mixai:prefs:v1, loads prehydrate.js + webapis.js + the bundle
public/prehydrate.js    GENERATED (packages/design-tokens) — applies theme prefs to <html> before paint
src/tokens.css          GENERATED (packages/design-tokens) — role colours (oklch), TV overrides under :root[data-tv]
src/styles.css          app CSS on top of the tokens; sRGB @supports fallback for Chromium < 111
src/i18n/messages.ts    RO + EN strings, t(), getLocale()/setLocale() (locale lives in mixai:prefs:v1)
src/i18n/useLocale.ts   [locale, setLocale] hook; App re-keys the tree on the mixai:locale event
src/lib/api.ts          MMO Server client (/video/*, OpenSubsonic /rest/*)
src/lib/focus.ts        geometric D-pad navigation over [data-focusable]
src/lib/tv-keys.ts      remote keyCodes (10009 back, 415/19/10252 media, colour keys)
src/lib/playback.ts     direct-play vs HLS decision for Tizen, codec caps
src/lib/progress.ts     resume positions (localStorage mixai-tv:progress, per TV)
src/lib/shows.ts        episode → show grouping (title, case-insensitive), S01E02 codes
src/lib/useStill.ts     preloads a background-image URL (sprite still) and hides it on error
src/lib/device-auth.ts  MixAI account device-code sign-in (mixai.ro/activate)
src/lib/discovery.ts    LAN sweep: webapis.network ip/mask → /24 × GET :17899/pair/info (400 ms, ×32)
src/lib/pair.ts         Quick Connect client (/pair/request, /pair/poll)
src/screens/*.tsx       Welcome · SignIn · Discover · Pair · Connect (manual + Quick Connect) · Home · Show · Search · Album · Player
src/screens/cards.tsx   VideoCard / ShowCard / AlbumCard / SkeletonCard / Row (shared)
scripts/package-wgt.ps1 build → .wgt (signed via Tizen Studio, or unsigned zip)
```

## Build

```powershell
cd apps/tv-tizen
pnpm install --ignore-workspace   # own lockfile (repo uses shared-workspace-lockfile=false)
pnpm typecheck               # tsc --noEmit
pnpm build                   # tsc + vite → dist/
pnpm package                 # dist/MixAITV.wgt (+ -Install to push via sdb)
```

`@vitejs/plugin-legacy` with `renderModernChunks=false` emits classic SystemJS scripts
(target `chrome >= 76`) — Tizen loads the widget from `file://`, where Chromium refuses
`<script type="module">`. Bundle: ~245 kB app + ~590 kB `hls.js` chunk that is fetched only
when a file needs HLS.

## Server API used

| Purpose | Endpoint |
|---|---|
| Discovery (sweep) | `GET /pair/info` → `{name,version,lanUrl,port,pairingSupported,hasToken}` |
| Quick Connect | `POST /pair/request {deviceName,platform:"tizen"}` → 201 `{code,secret,expiresAt,qr,approveUrl}`; `GET /pair/poll?code&secret` every 3 s |
| Health (saved server) | `GET /health` |
| Token check | `GET /video/flags` (header `x-device-token`) |
| Movie list | `POST /video/scan` `{}` → `{ files: ProbedVideo[] }` |
| Direct play | `GET /video/direct/:fileId?t=<token>&u=<userId>` (range requests) |
| HLS | `GET /video/stream/:fileId?q=original&caps=h264,hevc,aac,ac3,eac3,mp3&t&u` |
| Subtitles | `GET /video/subs/:fileId/:idx?t&u` (WebVTT via ffmpeg) |
| Poster | `GET /video/tmdb-image/w500/<path>?t&u` (only when the scan returns `posterPath`) |
| Still (poster fallback) | `GET /video/thumbs/:fileId/sprite.jpg?t&u` — 12×12 grid of 160×90 tiles; cards show tile 14 |
| Music | OpenSubsonic `/rest/{getAlbumList2,getAlbum,search3,stream,getCoverArt}.view?f=json&v=1.16.1&c=mixaitizen&apiKey=<token>` |

## Remote mapping

| Key | Action |
|---|---|
| ◀ ▶ ▲ ▼ | move focus (spatial) · in player: ±10 s / previous / next track |
| OK (13) | activate · in player: play/pause |
| BACK (10009) | previous screen · on Home: exit app |
| ⏯ ⏵ ⏸ ⏹ ⏪ ⏩ | registered via `tizen.tvinputdevice.registerKey` |
| Yellow | cycle subtitle track |

Search is a Home header button (OK on the input opens the Tizen IME). Language (RO/EN) and
"clear resume data" live in the Home → Settings row.

## Sideload (Developer Mode)

1. On the monitor: **Apps** → type `1 2 3 4 5` on the remote → *Developer mode* **ON**,
   *Host PC IP* = your PC (e.g. `192.168.100.61`) → reboot.
2. Install Tizen Studio 6.1 **CLI** (`web-cli_Tizen_Studio_6.1_windows-64.exe --accept-license "$HOME\tizen-studio"`),
  then `package-manager-cli.exe install --accept-license TV-SAMSUNG-Public-WebAppDevelopment TV-SAMSUNG-Extension-Tools cert-add-on`.
3. `pnpm setup:cert` → author certificate + security profile `mixai` (password kept only in
  `$HOME\tizen-studio-data\mixai-cert.env`).
4. `pnpm package -- -Install` → runs `tizen package -t wgt -s mixai -- dist` (signed: `author-signature.xml`
  + `signature1.xml`), `sdb connect 192.168.100.135`, `sdb install dist/MixAITV.wgt`.

Without Tizen Studio the script still emits an **unsigned** `dist/MixAITV.wgt`, which the
TV will refuse. If the TV rejects the default Tizen distributor cert ("certificate not matched"),
add the TV DUID (`sdb shell 0 getduid`) to a Samsung distributor cert via Certificate Manager.
Full RO walkthrough: [docs/aplicatie/tv-tizen.md](../../docs/aplicatie/tv-tizen.md#instalare-pe-odyssey-pas-cu-pas).

## Limitations

- **HTTP only on the LAN.** `access origin="*"` + `use.network` allow plain http to the
  server's IP; there is no TLS on MMO Server.
- **HEVC** plays only from MP4/MKV/TS containers via the server remux (`caps` includes
  `hevc`); the pre-remuxed sidecar (hvc1 + AAC) is preferred automatically by `/video/direct`.
- **MSE cap:** Tizen's MSE path (hls.js) is limited to FHD on most models; 4K needs native
  `<video src>` (direct play) — AVPlay is not used in this version.
- Tizen web apps have no mDNS/SSDP → discovery is an HTTP sweep of the TV's /24 on port 17899 only.
  Dev override: `?scanHosts=a,b` or `localStorage["mixai.scanHosts"]`. Manual entry is the fallback.
- **Tizen Chromium < 111 has no `oklch()`** — `styles.css` carries sRGB fallbacks (in a
  `@supports not (color: oklch(0 0 0))` block) mirrored from the generated `Tokens.kt`; re-copy
  them when tokens change.
- **Posters:** the server scan exposes no artwork; cards use frame 14 of the scrubber sprite,
  generated lazily by ffmpeg on first request (503 until then → 🎬 placeholder).
- **Resume positions are per-TV** (localStorage), not synced to the server or other devices.
