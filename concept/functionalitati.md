# 📝 Funcționalități — Feature List Complet

[🏠 Home](../README.md) · [📱 App](README.md)

---

## 📋 Feature Matrix

### 🔍 Scanner Module

| Feature | Prioritate | Complexitate | Versiune |
|---------|-----------|-------------|----------|
| Watch folder monitoring (chokidar) | 🔴 Critical | Medie | v0.1 |
| New file detection + notification | 🔴 Critical | Ușoară | v0.1 |
| Audio file validation (mp3, flac, wav, aiff) | 🔴 Critical | Ușoară | v0.1 |
| Read ID3 metadata | 🔴 Critical | Medie | v0.1 |
| BPM detection display | 🟡 High | Medie | v0.3 |
| Key detection display | 🟡 High | Medie | v0.3 |
| Auto-genre suggestion (BPM-based) | 🟡 High | Medie | v0.4 |
| Duplicate detection | 🟢 Medium | Medie | v0.5 |
| Batch processing | 🟢 Medium | Medie | v0.5 |

### 📁 Organizer Module

| Feature | Prioritate | Complexitate | Versiune |
|---------|-----------|-------------|----------|
| Move file to genre folder | 🔴 Critical | Ușoară | v0.2 |
| Rename file (convention) | 🟡 High | Medie | v0.2 |
| Create folder structure auto | 🟡 High | Ușoară | v0.2 |
| Undo move/rename | 🟡 High | Medie | v0.3 |
| Batch organize | 🟢 Medium | Medie | v0.4 |

### 🏷️ Tagger Module

| Feature | Prioritate | Complexitate | Versiune |
|---------|-----------|-------------|----------|
| Manual tag set (gen, energie, mood) | 🔴 Critical | Ușoară | v0.2 |
| Color assignment (energie→culoare) | 🟡 High | Ușoară | v0.3 |
| Rating/Energy 1-5 | 🔴 Critical | Ușoară | v0.2 |
| Auto-tag suggestion | 🟢 Medium | Grea | v1.0 |
| Batch tagging | 🟢 Medium | Medie | v0.5 |

### 💿 Drive Manager Module

| Feature | Prioritate | Complexitate | Versiune |
|---------|-----------|-------------|----------|
| List connected drives | 🔴 Critical | Ușoară | v0.5 |
| Drive capacity display | 🟡 High | Ușoară | v0.5 |
| Format detection (FAT32/NTFS) | 🟡 High | Medie | v0.5 |
| Safe eject | 🟡 High | Medie | v0.5 |
| Drive health check | 🟢 Medium | Grea | v1.0 |

### 💾 Export Module

| Feature | Prioritate | Complexitate | Versiune |
|---------|-----------|-------------|----------|
| Export playlist to USB | 🔴 Critical | Grea | v0.5 |
| Rekordbox XML generation | 🔴 Critical | Grea | v0.4 |
| PIONEER folder structure creation | 🔴 Critical | Grea | v0.5 |
| Sync (update only changed) | 🟡 High | Grea | v0.6 |
| Verify export integrity | 🟡 High | Medie | v0.5 |
| Backup USB → USB clone | 🟢 Medium | Medie | v0.6 |

### 📊 Dashboard

| Feature | Prioritate | Complexitate | Versiune |
|---------|-----------|-------------|----------|
| Stats overview (totals, inbox count) | 🔴 Critical | Ușoară | v0.1 |
| Genre distribution chart | 🟡 High | Medie | v0.3 |
| Recent activity log | 🟡 High | Ușoară | v0.2 |
| Quick actions | 🟡 High | Ușoară | v0.2 |
| BPM distribution chart | 🟢 Medium | Medie | v0.4 |
| Energy distribution chart | 🟢 Medium | Medie | v0.4 |

---

## 📊 Release Plan

```mermaid
gantt
    title Music Organizer Roadmap
    dateFormat  YYYY-MM-DD
    
    section v0.1 MVP
    Scanner basic           :a1, 2025-01-01, 14d
    Dashboard stats         :a2, after a1, 7d
    
    section v0.2
    File organizer          :b1, after a2, 14d
    Manual tagging          :b2, after b1, 7d
    
    section v0.3
    BPM/Key display         :c1, after b2, 14d
    Energy colors           :c2, after c1, 7d
    
    section v0.4
    RB XML integration      :d1, after c2, 21d
    Genre suggestion        :d2, after d1, 7d
    
    section v0.5
    Drive manager           :e1, after d2, 14d
    USB export              :e2, after e1, 14d
    
    section v1.0
    Auto-tag AI             :f1, after e2, 21d
    Polish & release        :f2, after f1, 14d
```

---

[🏠 Home](../README.md) · [📱 App](README.md)
