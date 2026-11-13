# MixAI Music — Google Cast receivers

Static files served by `apps/web` (Next 16, `public/`) at `https://mixai.ro/cast/…`. No build step.

| File | Purpose | Public URL |
|---|---|---|
| `receiver.html` / `receiver.js` / `receiver.css` | Branded **Custom Web Receiver** (CAF v3, audio only) | https://mixai.ro/cast/receiver.html |
| `tokens.css` | Byte copy of `packages/design-tokens/dist/tokens.plain.css` (generated — refresh after `pnpm tokens:build`; last refreshed 2026-11-12 with the product and mark colours) | https://mixai.ro/cast/tokens.css |
| `styled.css` | Stylesheet for a **Styled Media Receiver** registration (fallback / quick start) | https://mixai.ro/cast/styled.css |

`/cast` has no app route (`src/app/api/cast/*` lives under `/api/cast`, no collision) and `src/proxy.ts` skips
paths with a file extension, so host routing never rewrites these files. `next.config.ts` sets
`Cross-Origin-Resource-Policy: cross-origin` on `/cast/:path*`, `/logo.svg` and `/wordmark-dark.svg` so the
Styled Media Receiver (Google's origin) can load the stylesheet and logos. The global CSP already allows the CAF
SDK from `https://www.gstatic.com`.

Logos are generated files (`brand/scripts/build.mjs`, never edit them here): the custom receiver shows the
MixAI Music app icon `/icon-music-512.png` (same origin) and the family wordmark `/wordmark-dark.svg`; the styled
receiver can only load the two cross-origin files above, so it shows the family mark `/logo.svg`.

## What the receiver does

- Plays the standard CAF `LOAD` / `QUEUE_LOAD` / `QUEUE_*` messages sent by the Android sender (Media3
  `CastPlayer` + `DefaultMediaItemConverter`): title, artist, album, first artwork image.
- Idle: MixAI Music icon, "MixAI Music", "Ready to cast". Playing: blurred album-art backdrop, cover with crossfade,
  title/artist/album, progress with elapsed/total, "Next: title — artist" from the queue, paused and buffering
  overlays. 1920×1080 TVs and 1024×600 Nest Hub (sizes scale with `vmin`).
- Optional: `customData.accent` on LOAD (`violet|magenta|cyan|emerald|amber|rose`, anything else ignored).
- Optional: custom namespace `urn:x-cast:ro.mixai.music`, message
  `{"type":"lyrics","lines":[{"timeMs":0,"text":"…"}]}` renders the current line under the progress bar;
  `{"type":"lyrics-clear"}` hides it. Lyrics reset on every track change.

## Register in the Google Cast SDK Developer Console

Console: https://cast.google.com/publish (one-time 5 USD developer registration on the Google account).

### 1. Custom Receiver (recommended)

1. **Add new application** → **Custom Receiver**.
2. Name: `MixAI Music`. Receiver Application URL: `https://mixai.ro/cast/receiver.html`.
3. Save. Copy the **Application ID** (8 hex characters).
4. The app starts **Unpublished**: it only launches on registered test devices (step 3) until you press
   **Publish** (publishing takes ~15 minutes to propagate).

### 2. Styled Media Receiver (optional, alternative app id)

1. **Add new application** → **Styled Media Receiver**.
2. Name: `MixAI Music (styled)`. Skin URL: `https://mixai.ro/cast/styled.css` → **Preview** to check it.
3. Save and copy its Application ID. Use it only if you want Google's stock player UI with MixAI branding
   instead of the custom receiver.

### 3. Register test devices

1. **Devices** → **Add new device**.
2. Enter the Cast device **serial number** (Google Home app → device → Settings → Device information, or the
   label on the device) and a description.
3. Wait ~15 minutes, then **reboot** the Cast device so it picks up developer mode. Unpublished receivers launch
   only on these devices. Remote debugging: open `chrome://inspect` on a PC on the same network, or
   `http://<device-ip>:9222` (registered devices only).

### 4. Wire the app id into the Android sender

Put the Application ID in the Gradle property `mixaiCastAppId` (e.g. `~/.gradle/gradle.properties` or
`-PmixaiCastAppId=XXXXXXXX` on the command line) and rebuild `apps/music-android`. Without it the sender uses
the Default Media Receiver.

## Updating

- Edit the files here, bump `apps/web/package.json`, deploy the web app. Cast devices cache receivers briefly;
  relaunch the session (or reboot the device) to pick up changes.
- After a token change: `pnpm tokens:build`, then copy `packages/design-tokens/dist/tokens.plain.css` to
  `apps/web/public/cast/tokens.css`. The sRGB fallback block at the top of `receiver.css` and the colours in
  `styled.css` mirror the dark values of the generated `Tokens.kt`.
