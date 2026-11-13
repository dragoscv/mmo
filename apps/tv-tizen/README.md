# MixAI TV — Samsung Tizen (.wgt) and LG webOS (.ipk)

Tizen web application for Samsung Smart Hub TVs/monitors (tested target: Odyssey OLED G8,
Tizen 7); the same build is packaged for LG webOS and runs inside the desktop shell
(`apps/tv-desktop`). Connects to **MixAI Server** on the LAN (`http://<host>:17899`), browses movies and
music and plays them with the platform `<video>` element — progressive MP4 direct, HLS via
`hls.js` (lazy-loaded) for everything the server has to remux, WebVTT subtitles.

Standalone Vite + React 19 + TypeScript app; **no dependency on `apps/web`**. See
[ADR-0004](../../docs/adr/0004-tv-apps-compose-media3-and-tizen-web.md) and the Romanian
user guide in [`docs/aplicatie/tv-tizen.md`](../../docs/aplicatie/tv-tizen.md).

## Layout

```
config.xml              Tizen widget manifest (id http://mixai.ro/tv, app mXa1TvApp0.MixAI)
icon.png                GENERATED (brand/scripts/build.mjs) — 512×512 Tizen launcher icon, copied into dist/ by package-wgt.ps1
webos/appinfo.json      LG webOS manifest (id ro.mixai.tv); webos/icon.png (80×80) + webos/largeIcon.png (130×130) are GENERATED
index.html              <html data-tv data-mode="dark" …>, seeds mixai:prefs:v1, loads prehydrate.js + webapis.js + the bundle;
                        the boot screen between the `brand:*` markers is GENERATED (logo intro until React renders)
public/prehydrate.js    GENERATED (packages/design-tokens) — applies theme prefs to <html> before paint
public/brand-signature.wav  GENERATED (brand/scripts/build.mjs) — the ~1.4 s sonic signature
src/tokens.css          GENERATED (packages/design-tokens) — role colours (oklch), TV overrides under :root[data-tv]
src/styles.css          app CSS on top of the tokens; sRGB @supports fallback for Chromium < 111
src/i18n/messages.ts    RO + EN strings, t(), getLocale()/setLocale() (locale lives in mixai:prefs:v1)
src/i18n/useLocale.ts   [locale, setLocale] hook; App re-keys the tree on the mixai:locale event
src/lib/api.ts          MixAI Server client (/video/*, OpenSubsonic /rest/*)
src/lib/brand-sound.ts  plays the sonic signature once per app start (Settings → Sound → Startup sound, prefs key `startupSound`)
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
scripts/package-ipk.ps1 build → webos-out/ro.mixai.tv_<ver>_all.ipk (stages dist/ + webos/appinfo.json + both webOS icons)
```

Brand assets (icons, boot screen, sound) come from `node brand/scripts/build.mjs` at the repo root
([ADR-0016](../../docs/adr/0016-mixai-tv-name-brand-and-experience.md)); never edit them by hand.

## Build

```powershell
cd apps/tv-tizen
pnpm install   # own lockfile + pnpm-workspace.yaml (standalone project)
pnpm typecheck               # tsc --noEmit
pnpm build                   # tsc + vite → dist/
pnpm package                 # dist/MixAITV.wgt (+ -Install to push via sdb)
pnpm package:webos           # webos-out/*.ipk (ares-package)
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

## Startup sound

The sonic signature (`./brand-signature.wav`, relative URL because the widget runs from `file://`) plays once
per app start, after the first screen renders, through a plain `HTMLAudioElement` at volume 0.6. It is on by
default on TV; **Settings → Sound → Startup sound** turns it off (`startupSound: false` in `mixai:prefs:v1`).
If the engine blocks autoplay (the desktop webview can, before the first interaction), the sound is skipped for
that start — the rejection is ignored and there is no retry.

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

- **Ultrawide monitors (Odyssey 21:9 / 32:9):** `config.xml` declares
  `base_screen_resolution=extensive` and `index.html` uses `width=device-width`, so the app gets the
  native surface (Odyssey G8: 2580×1080) instead of a pillarboxed 16:9 window. Layout must stay
  responsive in width — never hardcode 1920. `lib/screen-format.ts` squeezes the UI only as a fallback
  when the engine still renders 16:9 on a wider panel (Settings → Screen format overrides).
- **HTTP only on the LAN.** `access origin="*"` + `use.network` allow plain http to the
  server's IP; there is no TLS on MixAI Server.
- **HEVC** plays only from MP4/MKV/TS containers via the server remux (`caps` includes
  `hevc`); the pre-remuxed sidecar (hvc1 + AAC) is preferred automatically by `/video/direct`.
- **MSE cap:** Tizen's MSE path (hls.js) is limited to FHD on most models; 4K needs native
  `<video src>` (direct play) — AVPlay is not used in this version.
- Tizen web apps have no mDNS/SSDP → discovery is an HTTP sweep of the TV's /24 on port 17899 only.
  Dev override: `?scanHosts=a,b` or `localStorage["mixai.scanHosts"]`. Manual entry is the fallback.
- **Tizen Chromium < 111 has no `oklch()`** — `styles.css` carries sRGB fallbacks (in a
  `@supports not (color: oklch(0 0 0))` block) mirrored from the generated `Tokens.kt`; re-copy
  them when tokens change.
- **Posters:** TMDB artwork when the server matched the title; otherwise `/video/thumbs/:id/still.jpg`
  (one keyframe ≈10 % in, cached by the server; 503 until ffmpeg is available → 🎬 placeholder).
- **Resume positions are per-TV** (localStorage), not synced to the server or other devices.
