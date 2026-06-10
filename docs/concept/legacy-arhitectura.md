# 🏗️ Arhitectura Tehnică — Music Organizer

[🏠 Home](../../README.md) · [📱 App](README.md)

---

## 🗺️ Arhitectură Overview

```mermaid
graph TD
    subgraph CLIENT["🖥️ Frontend (Next.js)"]
        DASH["📊 Dashboard"]
        SCAN_UI["🔍 Scanner View"]
        LIB_UI["📚 Library View"]
        DRV_UI["💿 Drive Manager View"]
        SET_UI["⚙️ Settings"]
    end
    
    subgraph SERVER["⚙️ Backend (Server Actions)"]
        SCAN_SA["scanFiles()"]
        ORG_SA["organizeFile()"]
        TAG_SA["tagTrack()"]
        EXP_SA["exportUSB()"]
        SYNC_SA["syncRekordbox()"]
    end
    
    subgraph DATA["💾 Data Layer"]
        DB["📦 SQLite/PostgreSQL"]
        FS["📂 File System"]
        XML["📄 Rekordbox XML"]
    end
    
    CLIENT --> SERVER
    SERVER --> DATA
    
    style CLIENT fill:#60a5fa,stroke:#2563eb,color:#000
    style SERVER fill:#facc15,stroke:#ca8a04,color:#000
    style DATA fill:#4ade80,stroke:#16a34a,color:#000
```

---

## 📊 Schema Database

```mermaid
erDiagram
    TRACK {
        int id PK
        string filepath
        string filename
        string artist
        string title
        string remix
        string label
        float bpm
        string key_camelot
        string key_musical
        int energy
        string genre
        string subgenre
        string mood
        string color
        string vocal_type
        string set_position
        int mixability
        boolean is_processed
        timestamp added_at
        timestamp analyzed_at
    }
    
    DRIVE {
        int id PK
        string path
        string label
        string type
        string format
        bigint capacity
        bigint used
        boolean is_active
    }
    
    PLAYLIST {
        int id PK
        string name
        string description
        string type
        timestamp created_at
    }
    
    PLAYLIST_TRACK {
        int playlist_id FK
        int track_id FK
        int position
    }
    
    SCAN_LOG {
        int id PK
        int drive_id FK
        string action
        string filepath
        timestamp scanned_at
    }
    
    TRACK ||--o{ PLAYLIST_TRACK : "in"
    PLAYLIST ||--o{ PLAYLIST_TRACK : "contains"
    DRIVE ||--o{ SCAN_LOG : "logged"
```

---

## 📂 Structura Proiect

```
music-organizer/
├── apps/
│   └── web/                    # Next.js 16 app
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx        # Dashboard
│       │   ├── library/
│       │   │   └── page.tsx    # Library view
│       │   ├── scanner/
│       │   │   └── page.tsx    # Scanner view
│       │   ├── drives/
│       │   │   └── page.tsx    # Drive manager
│       │   └── settings/
│       │       └── page.tsx    # Settings
│       ├── components/
│       │   ├── ui/             # shadcn/ui
│       │   ├── track-table.tsx
│       │   ├── drive-card.tsx
│       │   └── scanner-status.tsx
│       └── actions/
│           ├── scan.ts
│           ├── organize.ts
│           └── export.ts
├── packages/
│   ├── db/                     # Drizzle schema
│   ├── audio/                  # Audio analysis
│   └── fs-watcher/             # File system watcher
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 🔄 Flow-uri Principale

### 1. Scan Flow
```
chokidar watch → new file detected → read metadata (ID3) → 
analyze BPM/Key → suggest genre → insert DB → notify UI
```

### 2. Organize Flow
```
track in _Inbox → auto-detect genre → suggest folder → 
user confirms/changes → move file → update DB → update RB XML
```

### 3. Export Flow
```
select playlist → check USB format → copy files → 
generate PIONEER/ structure → write rekordbox XML → verify → eject
```

---

## 🔌 Rekordbox Integration

### Cum comunicăm cu rekordbox:
rekordbox folosește un **XML database** care poate fi import/export:

1. **Export din RB:** File → Library → Export as XML
2. **Modificare XML:** App-ul nostru citește/scrie XML-ul
3. **Import în RB:** File → Library → Import XML

```xml
<!-- Structura rekordbox XML -->
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" />
  <COLLECTION Entries="1234">
    <TRACK TrackID="1" 
           Name="Track Title" 
           Artist="Artist Name"
           Tonality="Am" 
           AverageBpm="128.00"
           Location="file://localhost/H:/Music/DJ/Techno/track.mp3">
      <TEMPO Inizio="0.123" Bpm="128.00" />
      <POSITION_MARK Name="Hot Cue A" Type="0" Start="32.456" Num="0" Red="255" />
    </TRACK>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="root">
      <NODE Type="1" Name="My Playlist" Entries="10">
        <TRACK Key="1" />
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
```

---

[🏠 Home](../../README.md) · [📱 App](README.md)
