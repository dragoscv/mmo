# 📚 Bibliotecă (`/library`)

> Inima MMO: navighezi, filtrezi și organizezi întreaga colecție de muzică.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎯 Ce faci aici

- Vezi **toate** track-urile din bibliotecă într-un tabel rapid și filtrabil
- Filtrezi după 15+ criterii simultan (BPM, key, energie, gen, mood, taguri, rating, favorite, etc.)
- Cauți după nume / artist / album
- Editezi tag-uri, marchezi favorite, pui rating, ascunzi tracks
- Lansezi în mixer / DAW / live cu un click

---

## 🖼️ Layout

```
┌──────────────────────────────────────────────────┐
│  🔍 Search    📊 Filters        ⚙️ Columns       │
├──────────────┬───────────────────────────────────┤
│              │                                   │
│  Filters     │  Track Table                      │
│  Sidebar     │  ┌────┬─────────┬────┬───┬───┐   │
│              │  │ ▶  │ Title   │BPM │Key│ ⭐│   │
│  • Genre     │  ├────┼─────────┼────┼───┼───┤   │
│  • BPM range │  │ ▶  │ Track 1 │128 │8A │ 4 │   │
│  • Key       │  │ ▶  │ Track 2 │140 │7B │ 5 │   │
│  • Energy    │  │ ...                            │
│  • Rating    │                                   │
│  • Tags      │                                   │
│  • Mood      │                                   │
│  ☆ Favorites │                                   │
└──────────────┴───────────────────────────────────┤
│  ◀ 1 2 3 ... 47 ▶   Show 50 ▾                   │
└──────────────────────────────────────────────────┘
```

---

## ⌨️ Acțiuni

| Acțiune | Cum |
|---------|-----|
| Play track | Click pe rândul track-ului sau pe ▶ |
| Adaugă în playlist | Click dreapta → "Adaugă în playlist" |
| Editează tag-uri | Click dreapta → "Edit tags" |
| Marchează favorit | Click pe ⭐ în coloana Rating |
| Setează rating | Click stele (1-5) |
| Filtrează rapid | Click pe genul/key-ul/tagul track-ului în tabel |
| Sortează | Click pe header coloană (toggle asc/desc) |
| Selectează multiple | Click + Shift / Ctrl |
| Acțiuni bulk | Selectează → toolbar apare sus |
| Ascunde tracks | Selectează → "Hide" |
| Vezi tracks ascunse | Toggle "Show hidden" în filtre |

---

## 🎛️ Filtre

Toate filtrele sunt **persistate în URL** (poți face bookmark sau share):

| Filtru | Ce filtrează |
|--------|--------------|
| **Genre** | Multi-select din genurile detectate |
| **BPM range** | Slider min/max (ex: 120-130) |
| **Key** | Multi-select Camelot wheel (1A-12B) |
| **Energy** | Slider 1-10 |
| **Rating** | Minim N stele |
| **Tags** | Match all / any din tagurile tale custom |
| **Mood** | happy, dark, energetic, mellow, etc. |
| **Favorites only** | Toggle |
| **Recently added** | Last 7/30/90 zile |
| **Recently played** | Last 7/30 zile |

---

## 🗂️ Coloane configurabile

Click ⚙️ Columns în header pentru a arăta/ascunde:

- ▶ Play indicator
- Album art thumbnail
- Title, Artist, Album, Genre
- BPM, Key (Camelot + clasic)
- Energy, Rating, Mood
- Duration, Bitrate, Format
- File path, Size
- Date added, Last played, Play count
- Tags
- Status (analyzed, missing, etc.)

Configurația se salvează în localStorage per utilizator.

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Server Actions | `getTracks()`, `getGenres()`, `getAllTags()`, `getKeys()` |
| Mutații | `toggleFavorite()`, `setTrackRating()`, `updateTrackTags()`, `hideTracks()`, `unhideTracks()` |
| State | URL params (nuqs) pentru filtre + paginare |
| Persistență | DB tables: `tracks`; localStorage: column visibility, scroll position |
| Performanță | Paginare server-side; row virtualization pentru tabele >1000 rows |

---

## 💡 Tips

- **Camelot wheel mixing**: filtrează după key compatibile cu un track de bază (ex: dacă ești în 8A, restrânge la 7A, 8A, 9A, 8B pentru armonie perfectă)
- **Energy build**: sortează după Energy ASC pentru un set care urcă progresiv
- **Smart playlists**: dacă găsești o combinație de filtre care îți place, salvează-o ca smart playlist din [`/playlists`](playlists.md)
- **Bulk re-tag**: selectează multiple tracks → "Edit tags" → adaugă același tag la toate

---

[← docs/aplicatie/](README.md) · [🎚️ Mixer →](mixer.md)
