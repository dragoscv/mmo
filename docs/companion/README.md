# 🖥️ MMO Companion — Ghid utilizator

> Aplicația desktop care extinde MMO Web App cu capabilități native: MIDI, audio low-latency, watch folders, scriere USB.

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md)

---

## 📚 Documente

| Document | Subiect |
|----------|---------|
| [instalare.md](instalare.md) | Cum instalezi pe Windows / macOS / Linux |
| [api-local.md](api-local.md) | Endpoints HTTP locale expuse pe `:17899` |
| [ipc-protocol.md](ipc-protocol.md) | Protocol IPC main ↔ renderer |
| [audio-pipeline.md](audio-pipeline.md) | Pipeline audio nativ (audify) |
| [auto-update.md](auto-update.md) | Cum funcționează auto-update prin GitHub Releases |

> Aceste ghiduri sunt în curs de scriere. Pentru setup dev → [`server/README.md`](../../server/README.md).

---

## ⚡ Cea mai rapidă cale

```bash
# 1. Descarcă pentru OS-ul tău:
#    https://github.com/dragoscv/mmo/releases/latest
#
#    - Windows:  MMO-Companion-Setup-X.Y.Z.exe
#    - macOS:    MMO-Companion-X.Y.Z-arm64.dmg (Apple Silicon)
#                MMO-Companion-X.Y.Z-x64.dmg   (Intel)
#    - Linux:    MMO-Companion-X.Y.Z.AppImage
#                mmo-companion_X.Y.Z_amd64.deb

# 2. Rulează installer / mount DMG / chmod +x AppImage

# 3. La pornire, deschide MMO Web App:
#    https://muzicai.ro
#    → bara laterală arată "✓ Companion connected"
```

---

## 🤔 De ce am nevoie de Companion?

| Capabilitate | Doar web app | Cu Companion |
|---|---|---|
| Browse bibliotecă | ✅ | ✅ |
| Mix DJ basic | ✅ | ✅ |
| Hardware MIDI (DDJ-FLX4, etc.) | ⚠️ Web MIDI cu limitări | ✅ Native, low-latency |
| Audio low-latency | ⚠️ ~20ms | ✅ ~5ms |
| Watch folders OS-level | ❌ | ✅ |
| Scriere directă USB CDJ | ❌ | ✅ |
| Auto-import din download | ⚠️ manual | ✅ automat |

---

## 🔐 Securitate & confidențialitate

- Companion-ul **nu trimite date** spre internet decât pentru auto-update (GitHub) și pentru a se conecta la web app-ul tău
- HTTP server-ul ascultă **doar pe loopback** (`127.0.0.1`) — niciun alt computer din rețea nu poate accesa
- Toate fișierele rămân local, sub controlul tău
- Open source — codul e [aici](https://github.com/dragoscv/mmo/tree/main/server)

---

[🏠 Home](../../README.md)
