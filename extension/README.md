# 🧩 MMO Browser Extension — Setup pentru dezvoltatori

> **MMO - Music Media Organizer Downloader** — extensie Chrome (MV3) care detectează audio/video pe 15+ platforme streaming și permite capturarea cu un click în biblioteca MMO.

[🏠 Home](../README.md)

---

## 🎯 Ce face

- Injectează un buton **"Capture to MMO"** în UI-ul fiecărei platforme suportate (content script)
- La click: extrage metadate (titlu, artist, URL, duration, thumbnail) și le trimite la web app sau companion
- Gestionează coadă offline (dacă web app-ul nu e disponibil)
- Configurabil prin `options.html` (URL web app, preferințe download)

---

## ⚡ Quick start (development)

1. Deschide Chrome → `chrome://extensions`
2. Activează **Developer mode** (toggle dreapta sus)
3. Click **Load unpacked**
4. Selectează folderul `extension/`
5. Extensia apare în toolbar

Pentru reload după modificări: click iconul ↻ pe cardul extensiei în `chrome://extensions`.

---

## 🗂️ Structura

```
extension/
├── manifest.json            Manifest V3 — permisiuni, content scripts, SW
├── background.js            Service Worker (orchestrare, message routing, downloads)
├── content.js               Content script — injectat în 15 platforme
├── content.css              Stiluri pentru butonul "Capture to MMO"
├── popup.html / popup.js    Popup-ul când dai click pe icon (status, link rapid)
├── options.html / options.js Pagina de settings
├── vendor/                  webextension-polyfill (cross-browser browser.* API)
├── package.json             Dev-only: pnpm vendor:polyfill regenerează vendor/
└── icons/                   Iconuri 16/48/128 px
```

---

## 🌐 Platforme suportate

15 platforme (vezi `manifest.json` → `host_permissions`):

| Platformă | Domain |
|-----------|--------|
| YouTube | `youtube.com`, `youtu.be` |
| YouTube Music | `music.youtube.com` |
| SoundCloud | `soundcloud.com` |
| Spotify | `spotify.com` |
| Bandcamp | `bandcamp.com` |
| Mixcloud | `mixcloud.com` |
| Vimeo | `vimeo.com` |
| TikTok | `tiktok.com` |
| Twitter / X | `twitter.com`, `x.com` |
| Instagram | `instagram.com` |
| Facebook | `facebook.com` |
| Twitch | `twitch.tv` |
| Dailymotion | `dailymotion.com` |
| Deezer | `deezer.com` |

---

## 🔌 Comunicare

```
Content Script (per tab)
    ↓ chrome.runtime.sendMessage
Service Worker (background.js)
    ↓ fetch (cu credentials: 'include')
Web App (https://muzicai.ro/api/download/info)
    ↓ (opțional)
Companion (http://127.0.0.1:17899/yt-dlp/download)
```

---

## 🔐 Permisiuni

Manifest declară doar:
- `storage` — pentru `chrome.storage.local` (config + queue)
- `activeTab` — pentru a rula scripturi temporar pe tab-ul activ

**NU** cerem `tabs`, `webRequest`, `cookies` sau alte permisiuni high-risk.

`host_permissions` listează doar cele 15 domenii muzicale — nu wildcard `*://*/*`.

---

## 🔄 Cum funcționează (per platformă)

Fiecare platformă are heuristici diferite pentru a detecta un track. În `content.js`:

```javascript
const adapters = {
    'youtube.com': () => detectYouTube(),
    'soundcloud.com': () => detectSoundCloud(),
    // etc.
};

const platform = window.location.hostname.replace(/^www\./, '');
const adapter = adapters[platform] || null;
if (adapter) {
    const track = adapter();
    if (track) injectButton(track);
}
```

Adăugarea unei platforme noi:
1. Adaugă domeniul în `manifest.json` (`host_permissions` + `content_scripts.matches`)
2. Implementează `detect<Platform>()` în `content.js`
3. Reîncarcă extensia în Chrome

---

## 🚧 Limitări cunoscute

- **Spotify**: nu permite descărcare directă (DRM); putem doar capta metadate pentru match cu YouTube/SoundCloud
- **Deezer**: similar Spotify
- **TikTok / Instagram**: video-uri private nu pot fi detectate
- **Firefox / Safari**: momentan **nu** sunt suportate (MV3 differences). Plan: adaptare cu `webextension-polyfill` post v1.0.

---

## 🐛 Troubleshooting

### Butonul nu apare pe o platformă
1. Hard refresh pagina (Ctrl+Shift+R)
2. Verifică în DevTools → Console că content script-ul s-a încărcat (caută `[MMO]`)
3. Verifică `chrome://extensions` → Errors

### "Capture failed"
1. Deschide popup-ul extensiei → verifică status conexiune cu web app
2. Asigură-te că ești logat în web app
3. Dacă folosești dev: `chrome.storage.local` cu `webAppUrl: 'http://localhost:3000'`

### Service Worker e suspendat
MV3 SW-urile se suspendă automat. Aceasta e normal. Reactivare la primul mesaj.

---

## 🔗 Linkuri

- 🏠 [README principal](../README.md)
- 📚 [Ghid user extension](../docs/extension/)
- 🏗️ [Arhitectură](../docs/arhitectura/02-componente-suite.md#-browser-extension-extension)
