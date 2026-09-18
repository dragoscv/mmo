# 🧩 MixAI Browser Extension — Setup pentru dezvoltatori

> **MixAI - Music Downloader** — extensie Chrome / Firefox (Manifest V3, vanilla JS) care adaugă un buton
> **„MixAI”** pe paginile de streaming și deschide pagina `/download` din aplicația web MixAI cu URL-ul
> media precompletat. Versiune curentă: **3.0.0**.

[🏠 Home](../../README.md) · [📚 Ghid utilizator](../../docs/extension/README.md)

---

## 🎯 Ce face (implementat)

1. **Buton în pagină** (`content.js` + `content.css`): pe paginile media ale platformelor suportate injectează
   `#mixai-download-btn` lângă acțiunile native (YouTube, YouTube Music, SoundCloud, Spotify, Bandcamp) sau,
   unde nu există un container stabil, un **buton plutitor** jos-dreapta (TikTok, Twitter/X, Mixcloud, Vimeo,
   Instagram, Facebook, Twitch, Dailymotion, Deezer și fallback-ul `generic` pentru orice pagină permisă care
   are un `<video>`/`<audio>`).
2. **Click** → `background.js` deschide `<baseUrl>/download?url=<pagina>[&auto=1][&audio=1]` într-un tab nou.
   `auto=1` vine din opțiunea *Auto-download*, `audio=1` din *Audio only* (setările sunt în `storage.sync`).
3. **Popup** (`popup.html/js`): pagina curentă + platforma detectată, „Descarcă audio / Descarcă”, „Deschide în
   MixAI”, link către setări; versiunea e citită din `runtime.getManifest().version`.
4. **Opțiuni** (`options.html/js`): URL-ul aplicației MixAI (implicit `https://mixai.ro`, dev
   `http://localhost:13789`), Auto-download, Audio only.
5. **Beacon** (`beacon.js`, doar pe `mixai.ro`): marchează pagina ca având extensia instalată.
6. **i18n**: `_locales/en` + `_locales/ro` (`default_locale: en`); `manifest.json` folosește `__MSG_…__`,
   paginile folosesc `browser.i18n.getMessage` prin `i18n.js` (`data-i18n` pe elemente).
7. **Design tokens**: `tokens.css` este **generat** din `packages/design-tokens` (`pnpm tokens:build` la root) —
   nu se editează manual. Popup/options folosesc doar `var(--…)` și urmează `prefers-color-scheme`
   (`data-mode` setat dintr-un script inline). `content.css` nu poate încărca `tokens.css` în pagini străine, așa
   că definește aceleași valori OKLCH scoped pe `#mixai-download-btn`. Iconițele `icons/*.svg` folosesc
   gradientul brand violet → magenta.

Extensia **nu** descarcă nimic singură și nu trimite metadate: tot fluxul de descărcare (yt-dlp, companion,
bibliotecă) e în aplicația web.

---

## ⚡ Quick start (development)

1. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** → folderul `apps/extension/`
   (Firefox: `about:debugging` → *Load Temporary Add-on* → `manifest.json`).
2. Reload după modificări: iconul ↻ pe cardul extensiei.
3. `pnpm install --ignore-workspace` + `pnpm vendor:polyfill` doar dacă actualizezi `webextension-polyfill`.

Orice commit care atinge `apps/extension/**` trebuie să bumpeze `version` în **ambele** fișiere
`manifest.json` și `package.json` (`scripts/check-version.mjs`, rulat de husky și de `extension-ci.yml`).

---

## 🗂️ Structura

```
apps/extension/
├── manifest.json            MV3 — permisiuni, content scripts, SW, default_locale
├── _locales/{en,ro}/        messages.json (26 chei fiecare)
├── background.js            Service Worker: construiește URL-ul /download, deschide tab
├── content.js               Content script: PLATFORM_CONFIGS (14 adaptoare + generic) + injectare buton
├── content.css              Stiluri scoped pe #mixai-download-btn (OKLCH, light/dark)
├── popup.html / popup.js    Popup toolbar
├── options.html / options.js Setări
├── i18n.js                  Helper t() / applyI18n() pentru popup & options
├── beacon.js                Rulează doar pe mixai.ro
├── tokens.css               GENERAT (packages/design-tokens) — nu edita
├── icons/                   icon16/32/48/128.svg (gradient brand)
├── vendor/                  webextension-polyfill
└── scripts/check-version.mjs Guard de versiune (husky + CI)
```

---

## 🌐 Platforme (adaptoare în `content.js`)

| Platformă | Domenii | Injectare | Pagini media |
|-----------|---------|-----------|--------------|
| YouTube | `youtube.com`, `youtu.be` | inline (`#top-level-buttons-computed`) | `/watch`, `/shorts/*` |
| YouTube Music | `music.youtube.com` | inline (player bar) | `/watch` |
| SoundCloud | `soundcloud.com` | inline (`.soundActions`) | `/user/track` |
| Spotify | `spotify.com` | inline (`action-bar-row`) | `/track/*`, `/album/*` |
| Bandcamp | `bandcamp.com` | inline (`.tralbumCommands`) | `/track/*`, `/album/*` |
| TikTok | `tiktok.com` | inline / plutitor | `/video/*` |
| Twitter / X | `twitter.com`, `x.com` | inline / plutitor | `/status/*` |
| Mixcloud | `mixcloud.com` | lângă `h1` / plutitor | `/user/show/` |
| Vimeo | `vimeo.com` | plutitor | pagini cu `<video>` |
| Instagram | `instagram.com` | plutitor | `/p/`, `/reel/`, `/tv/` |
| Facebook | `facebook.com` | plutitor | `/watch`, `/videos/`, `/reel/` |
| Twitch | `twitch.tv` | plutitor | `/videos/*`, clipuri |
| Dailymotion | `dailymotion.com` | lângă `h1` / plutitor | `/video/*` |
| Deezer | `deezer.com` | plutitor | `/track/`, `/album/`, `/playlist/` |
| *generic* | orice host permis | plutitor | pagini cu `<video>`/`<audio>` |

Adăugarea unei platforme: domeniul în `manifest.json` (`host_permissions` + `content_scripts.matches`), o
intrare în `PLATFORM_CONFIGS` (`match`, `isMediaPage`, `buttonTarget` sau `floating: true`), bump de versiune.

---

## 🔐 Permisiuni

`storage` (setări în `storage.sync`) și `activeTab`. `host_permissions` = doar domeniile de mai sus +
`mixai.ro` / `localhost:13789`. Fără `tabs`, `webRequest`, `cookies`.

---

## 🐛 Troubleshooting

- **Butonul nu apare**: hard refresh; verifică `chrome://extensions → Errors`; paginile SPA se re-scanează la
  schimbarea URL-ului (MutationObserver + `popstate` + `yt-navigate-finish`).
- **Se deschide un URL greșit**: verifică *MixAI app base URL* în Opțiuni (fără `/` final).
- **SW suspendat**: normal în MV3; se trezește la primul mesaj.

---

## 🗺️ Roadmap (neimplementat)

- Extragerea metadatelor (titlu, artist, durată, thumbnail) în content script și trimiterea lor la
  `/api/download/info`.
- Coadă offline în `storage.local` când aplicația web nu e disponibilă.
- Trimitere directă către MixAI Companion (`http://127.0.0.1:17899`) fără a deschide web app-ul.
- Publicare în Chrome Web Store / AMO.
