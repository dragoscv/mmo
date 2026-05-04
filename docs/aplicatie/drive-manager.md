# 💿 Drive Manager (`/drives`)

> Vezi drive-urile conectate (interne + USB) și pregătește export-uri pentru CDJ.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎯 Ce faci aici

- Vezi toate drive-urile conectate cu detalii (label, format, capacitate)
- Monitorizezi spațiul liber (util înainte de export USB mare)
- Refresh-ezi detecția drive-urilor (după inserare USB)

> **Export-ul propriu-zis** (copiere tracks + generare rekordbox XML pe USB) se face din [`/playlists`](playlists.md) → "Export to USB" și necesită [MMO Companion](../companion/README.md).

---

## 🖼️ Layout

```
┌──────────────────────────────────────────┐
│  💿 Drives                  [⟳ Refresh]  │
├──────────────────────────────────────────┤
│  ┌────────────────┐  ┌────────────────┐ │
│  │ 💾 H:\         │  │ 🟧 USB E:\     │ │
│  │ Music Drive    │  │ Pioneer USB    │ │
│  │ NTFS           │  │ FAT32          │ │
│  │ ████████░░ 82% │  │ ███░░░░░░░ 28% │ │
│  │ 1.2 TB / 1.5TB │  │ 8.7 GB / 32 GB │ │
│  └────────────────┘  └────────────────┘ │
└──────────────────────────────────────────┘
```

---

## ⌨️ Acțiuni

| Acțiune | Cum |
|---------|-----|
| Vezi toate drive-urile | Auto la încărcare |
| Refresh | Click "⟳ Refresh" (după inserare USB) |
| Filtrează doar USB-uri | Click filter "Removable" |
| Export pe USB | Mergi la [`/playlists`](playlists.md) → selectează playlist → "Export to USB" |

---

## 💾 Drive types

| Tip | Icon | Detalii |
|-----|------|---------|
| **HDD intern** | 💾 | Hard disk fix |
| **SSD** | 💽 | Solid state intern |
| **USB removable** | 🟧 | Stick / SSD extern USB |
| **Network drive** | 🌐 | SMB / NFS mount |
| **Optical** | 📀 | CD/DVD/Blu-ray |

---

## 📋 Pentru USB CDJ — checklist înainte de export

- ✅ **Format FAT32** (CDJ-uri Pioneer cer FAT32; cu fișiere >4GB → exFAT, dar nu toate CDJ-urile suportă)
- ✅ **Spațiu liber** suficient (verifică aici %)
- ✅ **Etichetă** (label) sugestiv ("CDJ-MAIN", "CDJ-BACKUP")
- ✅ **Test inițial** pe CDJ-ul tău acasă înainte de gig

> Pentru ghid complet de export USB → [`organizare/export-usb.md`](../../organizare/export-usb.md)

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Server Action | `detectDrives()` |
| Backend Windows | `wmic logicaldisk get` (sau `Get-PSDrive`) |
| Backend macOS | `diskutil list` |
| Backend Linux | `lsblk -J` |
| Cu Companion | API nativ Node.js + permisiuni OS |
| Refresh | Manual (no auto-poll pentru a nu încărca CPU) |

---

## ⚠️ Limitări

- **Detecție momentan optimizată pentru Windows**; macOS/Linux: support de bază
- **Fără auto-eject** din UI — folosește OS-ul (taskbar Windows / Finder macOS)
- **Fără partition info** detaliat (doar volume, nu partiții)
- **Network drives** apar doar dacă sunt mount-uite la pornirea aplicației

---

## 💡 Tips

- **Două USB-uri identice** la gig: unul "main", unul "backup". Etichetează-le clar.
- **Verifică SMART** periodic pentru drive-urile cu biblioteca principală (extern unelte: CrystalDiskInfo / smartctl)
- **Backup recurent**: replicare pe NAS sau cloud → vezi [`docs/profesional/05-backup-disaster.md`](../profesional/05-backup-disaster.md)

---

[← Download](download.md) · [🎛️ DAW Editor →](daw-editor.md)
