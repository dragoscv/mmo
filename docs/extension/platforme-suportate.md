# 🌐 Platforme suportate — Extensia MixAI

[🏠 Home](../../README.md) · [🧩 Extension](README.md)

Extensia rulează pe **15 platforme** (plus un fallback generic). Pe fiecare pagină media adaugă butonul
**„MixAI”**; la click se deschide `/download` în aplicația web cu URL-ul precompletat. Descărcarea propriu-zisă
o face MixAI (web + Companion), nu extensia.

| Platformă | Unde apare butonul | Ce merge |
|-----------|--------------------|----------|
| YouTube | lângă Like/Share, pe `/watch` și Shorts | audio sau video |
| YouTube Music | în bara playerului | audio |
| SoundCloud | lângă acțiunile track-ului | audio |
| Spotify | în bara de acțiuni (track/album) | doar metadate — DRM; MixAI caută echivalentul pe YouTube/SoundCloud |
| Bandcamp | sub comenzile albumului/track-ului | audio |
| TikTok | lângă acțiunile videoului / plutitor | video / audio |
| Twitter / X | în grupul de acțiuni al postării / plutitor | video / audio |
| Mixcloud | lângă titlul show-ului / plutitor | audio (unde platforma permite) |
| Vimeo | buton plutitor | video / audio |
| Instagram | buton plutitor (postări, reels, IGTV) | video / audio; conținutul privat nu |
| Facebook | buton plutitor (Watch, videos, reels) | video / audio; conținutul privat nu |
| Twitch | buton plutitor pe VOD-uri și clipuri | video / audio (live-ul nu) |
| Dailymotion | lângă titlu / plutitor | video / audio |
| Deezer | buton plutitor | doar metadate — DRM |
| *generic* | buton plutitor pe orice pagină permisă cu `<video>`/`<audio>` | depinde de sursă |

**Buton plutitor** = colț dreapta-jos, deasupra zonei safe-area; îl folosim acolo unde platforma nu are un
container stabil în care să inserăm inline.

Lista tehnică (selectoare, reguli de URL) e în [`apps/extension/README.md`](../../apps/extension/README.md).
