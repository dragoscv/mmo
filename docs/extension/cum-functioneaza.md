# ⚙️ Cum funcționează — Extensia MixAI

[🏠 Home](../../README.md) · [🧩 Extension](README.md)

## Fluxul la un click

```
Pagina de streaming (content.js)
    │  detectează platforma + pagina media, injectează butonul „MixAI”
    ▼ browser.runtime.sendMessage({ type: "open-download", url, autoDownload, audioOnly })
Service Worker (background.js)
    │  citește setările din storage.sync
    ▼ browser.tabs.create(<baseUrl>/download?url=…[&auto=1][&audio=1])
Aplicația web MixAI (/download)
    │  afișează info media, pornește descărcarea (auto=1 = imediat)
    ▼
MixAI Companion (dacă e instalat) → fișierul ajunge în bibliotecă (/library)
```

- Extensia **nu** descarcă și **nu** trimite metadate singură — doar deschide pagina potrivită în MixAI.
- Popup-ul din toolbar face același lucru pentru tab-ul curent („Descarcă audio” = `auto=1`, „Deschide în
  MixAI” = fără auto).
- Dacă nu ești autentificat în MixAI, pagina `/download` te trimite la login și revine.

## Setări (click dreapta pe icon → Opțiuni)

| Setare | Efect |
|--------|-------|
| **URL-ul aplicației MixAI** | implicit `https://mixai.ro`; pentru dev local `http://localhost:13789` |
| **Descărcare automată la click** | adaugă `auto=1` — descărcarea pornește imediat ce se deschide pagina |
| **Doar audio** | adaugă `audio=1` — cere doar pista audio |

Setările sunt sincronizate prin `storage.sync` (același cont de browser pe mai multe PC-uri).

## Limbă și temă

Textele urmează limba browserului (română / engleză). Popup-ul și pagina de opțiuni urmează tema sistemului
(light/dark) și folosesc paleta MixAI („Neon Nocturne”).

## Permisiuni

`storage` și `activeTab`, plus acces doar la domeniile platformelor suportate și la `mixai.ro`. Fără acces la
istoric, parole sau alte tab-uri.
