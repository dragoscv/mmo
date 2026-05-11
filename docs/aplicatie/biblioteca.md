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
| **Sugestie AI bulk** | Selectează → ✨ AI Suggest (umple gen / mood / energie pe tot batch-ul) |
| Vezi tracks ascunse | Toggle "Show hidden" în filtre |
| **Import rekordbox XML** | Buton "Import" în header → încarcă `rekordbox.xml` |
| **Export rekordbox XML** | Buton "Export XML" în header → descarcă XML cu toată biblioteca grupată pe gen |

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

## ✨ AI auto-tag (BYO key)

Modal-ul de detalii track + bara bulk au un buton **"Suggest with AI"** care folosește providerul tău (OpenAI / Anthropic / Google / Mistral / Groq) pentru a propune **doar pentru câmpurile goale**: genre, subgenre, mood, vocalType, setPosition, mixability (1-5), energy (1-10).

- Cheia API o adaugi în `Settings → AI provider keys`. E criptată AES-256-GCM la repaus și nu părăsește niciodată serverul în plaintext (clientul vede doar mască `sk-…XXXX`).
- Poți seta un **provider preferat** în același panou; dacă acela eșuează, restul providerilor configurați sunt fallback automat.
- **Bulk** procesează maxim 50 de tracks per click, secvențial (ca să nu lovești rate-limit-ul providerului). Selectează > 50 și UI-ul îți spune câte au fost lăsate pentru următoarea rulare.
- **Nu suprascrie nimic** — doar completează câmpuri goale. Rulează de mai multe ori în siguranță.
- Costul tipic per track: ~500 tokens out, ~250 tokens in → la `gpt-4o-mini` ≈ $0.0003/track. La 1000 tracks ≈ $0.30.

---

## 💿 Round-trip rekordbox XML

| Direcție | Cum | Endpoint |
|---|---|---|
| Import | `/library/import` (wizard) sau buton "Import" în header | Server Action `importRekordboxXml` |
| Export bibliotecă | Buton "Export XML" în header | `GET /api/export/rekordbox` |
| Export playlist single | Pagina `/playlists` → buton "Export XML" pe playlist | `GET /api/export/rekordbox?scope=playlist&playlistId=N` |

Exportul produce XML compatibil rekordbox 7.0 (`<DJ_PLAYLISTS Version="1.0.0">`), grupat by-default pe gen pentru biblioteca completă. Nodurile `<TRACK>` includ: TrackID, Name, Artist, Album, Genre, Tonality, AverageBpm, TotalTime, Location (`file://localhost/...`), BitRate, SampleRate, Rating (energy×51, mapat la stelele rekordbox), Comments (`E{energy} | {mood} | {setPosition} | {color}`).

Limita curentă: 100 000 tracks per export. Fișierul se descarcă cu denumirea `mmo-rekordbox-library-YYYY-MM-DD.xml` (sau `mmo-rekordbox-{playlist}-YYYY-MM-DD.xml` pentru un playlist).

---

[← docs/aplicatie/](README.md) · [🎚️ Mixer →](mixer.md)
