# 🏠 Dashboard (`/`)

> Pagina de start: privire de ansamblu peste biblioteca, scan-uri recente, recomandări și acțiuni rapide.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎯 Ce vezi aici

- **Statistici** rapide despre biblioteca ta
- **Recent scans** (ultimii 10) — ce s-a indexat recent
- **Recommended playlists** (smart playlists generate automat)
- **Quick actions** — shortcut-uri către cele mai folosite module

---

## 🖼️ Layout

```
┌────────────────────────────────────────────────┐
│  👋 Bun venit, DJ Vlad                         │
├────────────────────────────────────────────────┤
│  📊 Stats                                      │
│  ┌──────────┬──────────┬──────────┬─────────┐ │
│  │ Tracks   │ Playlists│ BPM range│ Avg key │ │
│  │  4,287   │    23    │ 60-180   │   8A    │ │
│  └──────────┴──────────┴──────────┴─────────┘ │
│  Energy distribution:                          │
│  ▁▃▅▇▇▅▃▁ (1 → 10)                            │
├────────────────────────────────────────────────┤
│  📥 Recent Scans                               │
│  • H:\Music\Inbox      — 12 noi   2h ago       │
│  • E:\Downloads        —  3 noi   5h ago       │
│  • H:\Music\DJ\Techno  —  8 noi   yesterday    │
│  ... (până la 10)                              │
├────────────────────────────────────────────────┤
│  ⚡ Recommended Playlists                       │
│  [card] High Energy 128-132 BPM (47 tracks)    │
│  [card] Late Night Deep    (32 tracks)         │
│  [card] Recently Added     (last 30 zile)      │
├────────────────────────────────────────────────┤
│  🚀 Quick Actions                              │
│  [📚 Library] [🎚️ Mixer] [⬇ Download] [🔍 Scan]│
└────────────────────────────────────────────────┘
```

---

## ⌨️ Acțiuni

| Click | Te duce la |
|-------|------------|
| Stats card | [`/library`](biblioteca.md) cu filtru aplicat |
| Recent scan | [`/library`](biblioteca.md) cu filter "Recently added" |
| Playlist card | [`/playlists`](playlists.md) cu playlist-ul deschis |
| Quick action | Direct către modul |
| Energy bar | Filtrează library după energy band |

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Server Actions | `getDashboardStats()`, `getRecentScans(10)`, `getRecommendedPlaylists()` |
| Cache | `"use cache"` cu revalidate 5 min — refresh automat |
| Stats query | COUNT/AVG/MIN/MAX agregate Drizzle |
| Energy distribution | Histogram pe `energy` field din `tracks` |

---

## 💡 Tips

- **Quick start după install**: dacă dashboard arată gol, mergi la [`/scanner`](scanner.md) sau [`/settings`](settings.md) → Music Root
- **Daily workflow**: după ce pui muzică nouă în Inbox, deschide dashboard pentru a vedea instant ce s-a indexat
- **Recomandările se updatează** după ce asculți / mixezi mai mult — sistemul învață ce-ți place

---

## 🔮 Roadmap

- "What's new" feed (anunțuri update + features noi)
- Listening insights (hours played, top genres, peaks)
- Goal tracker (ex: "indexează 5,000 tracks", "fă 10 mix-uri lună")
- Calendar event-uri (gig-uri viitoare cu prep playlist)

---

[📚 docs/aplicatie/](README.md) · [🏠 Home](../../README.md)
