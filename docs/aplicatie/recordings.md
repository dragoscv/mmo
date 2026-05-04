# 🎙️ Recordings (`/recordings`)

> Toate înregistrările tale (mix-uri, sesiuni live, exporturi DAW, edit-uri editor) într-un singur loc.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎯 Ce faci aici

- Vezi toate înregistrările salvate din orice modul (Mixer / Live / DAW / Editor)
- Ascultă preview rapid
- Redenumești, ștergi, marchezi favorite
- Descărci local pentru backup / share

---

## 🖼️ Layout

```
┌──────────────────────────────────────────────┐
│  🔍 Search   Filter: [All ▾] [Date ▾] [⭐]  │
├──────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────┐│
│  │ 🎚️ Mixer  "Friday Sunset Mix"          ││
│  │ 2026-05-02 · 1h 24m · 124 MB · ⭐      ││
│  │ ▶ Play   ✎ Rename   ⬇ Download   🗑   ││
│  ├─────────────────────────────────────────┤│
│  │ 🎤 Live   "Acoustic Session"           ││
│  │ 2026-04-28 · 38m · 67 MB               ││
│  │ ▶ Play   ✎ Rename   ⬇ Download   🗑   ││
│  ├─────────────────────────────────────────┤│
│  │ 🎛️ DAW    "Track Demo v3"              ││
│  │ 2026-04-25 · 4m 32s · 41 MB · ⭐       ││
│  │ ...                                     ││
│  └─────────────────────────────────────────┘│
└──────────────────────────────────────────────┘
```

---

## ⌨️ Acțiuni

| Acțiune | Cum |
|---------|-----|
| Filtrează după sursă | Dropdown "All" → Mixer / Live / DAW / Editor |
| Caută | Type în search bar |
| Play preview | Click ▶ |
| Marchează favorit | Click ⭐ |
| Redenumește | Click ✎ |
| Descarcă | Click ⬇ — salvează `.wav` sau `.mp3` |
| Șterge | Click 🗑 (cu confirmare) |
| Vezi dosar | Click "Open folder" — deschide locația în file explorer |

---

## 📁 Format & locație

| Sursă | Format default | Locație |
|-------|---------------|---------|
| Mixer | WAV 44.1kHz 16-bit stereo | `<music-root>/recordings/mixer/` |
| Live | WAV 48kHz 24-bit stereo | `<music-root>/recordings/live/` |
| DAW export | WAV / MP3 (la alegere) | `<music-root>/recordings/daw/` |
| Editor export | Aceleași ca sursa | `<music-root>/recordings/editor/` |

> Locația e configurabilă în [`/settings`](settings.md) → Recordings folder.

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Server Actions | `listRecordings()`, `getRecordingsFolder()`, `deleteRecording()`, `renameRecording()`, `toggleRecordingFavorite()` |
| API audio | `/api/recordings/[id]/audio` — streaming cu Range |
| Salvare | `/api/recordings/save` — POST cu blob WAV |
| Storage | File system (managed by web app sau Companion) |
| Metadata | DB table extra (TBD) sau extragere din file ID3 |

---

## 💡 Tips

- **Backup recurent**: copiază `recordings/` pe NAS sau cloud (proteja-te de file loss)
- **Compresie**: mix-urile lungi în WAV ocupă spațiu (1h ≈ 600 MB); convertește la FLAC pentru economie ~50% fără pierdere calitate
- **Naming**: redenumește imediat după înregistrare (ex: "2026-05-02 Friday Bounce Set @home")
- **Cloud sync**: pentru access de oriunde, mută folderul `recordings/` într-un sync provider (Drive, OneDrive, Dropbox)
- **Cu Companion**: înregistrarea folosește audio nativ, latență 0 între deck output și fișier

---

## 🔮 Roadmap

- Auto-cloud upload (S3 / Drive)
- Auto-tagging (BPM, energy în recordings)
- Trim / split direct din UI (fără să intri în editor)
- Share link (audio public protected by token)

---

[← Playlists](playlists.md) · [🔌 Devices →](devices.md)
