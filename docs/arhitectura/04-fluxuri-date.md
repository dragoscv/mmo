# 04 — Fluxuri de date

> [← 03](03-stack-tehnologic.md) · [05 →](05-securitate-auth.md)

Diagrame sequence pentru cele mai importante fluxuri din MMO.

---

## 1. 📁 Auto-import: track nou apare în watch folder

```mermaid
sequenceDiagram
    autonumber
    participant FS as File System
    participant CO as Companion (chokidar)
    participant WA as Web App
    participant DB as Drizzle DB
    participant UI as Browser UI

    Note over FS: Userul copiază<br/>"track.mp3" în<br/>watch folder
    FS->>CO: chokidar 'add' event
    CO->>CO: extract metadata<br/>(music-metadata)
    CO->>WA: POST /api/scan/ingest<br/>{ filepath, size, metadata }
    WA->>DB: INSERT tracks<br/>(status=pending)
    WA->>DB: INSERT analysisJobs<br/>(track_id, status=queued)
    WA-->>CO: 200 { trackId }

    par Background analysis
        WA->>WA: analysis worker picks up job
        WA->>WA: compute BPM, key, energy<br/>(fft, beat detection)
        WA->>DB: UPDATE tracks SET<br/>bpm, key, energy<br/>UPDATE jobs SET status=done
    and Live UI update
        UI->>WA: GET /api/analysis/stream (SSE)
        WA-->>UI: event: 'job-update'<br/>{ trackId, progress }
        UI->>UI: re-render row in /library
    end
```

---

## 2. 🎚️ Mixaj live cu DDJ-FLX4

```mermaid
sequenceDiagram
    autonumber
    participant DJ as DJ
    participant DDJ as DDJ-FLX4
    participant BR as Browser (Web MIDI)
    participant ME as mixer-engine
    participant WA as Web Audio API
    participant SP as Speakers

    DJ->>DDJ: move jog wheel
    DDJ->>BR: MIDI CC msg<br/>(channel, controller, value)
    BR->>ME: midi.onMessage(msg)
    ME->>ME: map MIDI → action<br/>(deck A: scratch +5%)
    ME->>WA: AudioBufferSource.playbackRate = 1.05
    WA->>SP: PCM frames

    Note over BR,WA: Tot acest flux<br/>e ~5ms latency<br/>(suficient pentru DJ live)

    Note over BR: Deci-uri loaded:<br/>fetch /api/audio/[trackId]<br/>cu Range header pentru seek
```

---

## 3. ⬇️ Download din YouTube prin extensie

```mermaid
sequenceDiagram
    autonumber
    participant YT as YouTube tab
    participant CS as Content Script
    participant SW as Service Worker
    participant WA as Web App
    participant CO as Companion
    participant FS as File System

    Note over YT: User pe<br/>youtube.com/watch?v=...
    CS->>YT: inject "Capture to MMO" button
    YT->>CS: user click
    CS->>SW: { type: 'capture', url, title, channel, duration }
    SW->>WA: POST /api/download/info<br/>(cu user session cookie)
    WA->>WA: validate URL<br/>Zod schema
    WA->>WA: check duplicate (DB lookup)
    WA-->>SW: 200 { trackId, action: 'download' }
    SW->>WA: POST /api/download/start<br/>{ trackId }
    WA->>CO: POST /yt-dlp/download<br/>{ url, dest: musicRoot }
    CO->>CO: spawn yt-dlp process
    loop while downloading
        CO-->>WA: SSE 'progress' { percent }
        WA-->>SW: SSE 'progress'
    end
    CO->>FS: write track.mp3
    Note over FS: Watch folder picks up<br/>→ vezi flow #1<br/>(auto-import)
```

> **Notă**: dacă companion-ul nu e instalat, web app-ul poate face fallback la un endpoint server-side care rulează `yt-dlp` (cu rate limiting și verificări legale).

---

## 4. 📡 Sesiune remote (doi DJ-i, audio P2P)

```mermaid
sequenceDiagram
    autonumber
    participant A as DJ A (browser)
    participant WA as Web App (signaling)
    participant T as TURN
    participant B as DJ B (browser)

    A->>WA: GET /api/turn-credentials
    WA->>WA: HMAC-SHA1(secret,<br/>username=`<expiry>:<userId>`)
    WA-->>A: { iceServers: [...] }

    A->>WA: POST /api/remote/session<br/>{ inviteCode }
    WA-->>A: { sessionId }
    A->>WA: GET /api/remote/events?sessionId (SSE)

    Note over A,B: B se alătură<br/>cu inviteCode
    B->>WA: POST /api/remote/join { inviteCode }
    WA-->>B: { iceServers, sessionId }
    B->>WA: GET /api/remote/events?sessionId (SSE)

    A->>A: createOffer()
    A->>WA: POST /api/remote/send<br/>{ to: B, type: 'offer', sdp }
    WA-->>B: SSE 'offer' { sdp }
    B->>B: setRemoteDescription + createAnswer
    B->>WA: POST /api/remote/send<br/>{ to: A, type: 'answer', sdp }
    WA-->>A: SSE 'answer' { sdp }

    par ICE candidates
        A->>WA: POST /api/remote/send<br/>{ type: 'ice', candidate }
        WA-->>B: SSE 'ice'
        B->>WA: POST /api/remote/send<br/>{ type: 'ice', candidate }
        WA-->>A: SSE 'ice'
    end

    Note over A,B: WebRTC connection established
    alt Direct (P2P)
        A-->>B: Opus audio @ 96 kbps<br/>~50ms latency
    else NAT prevents direct
        A->>T: relay
        T->>B: relay<br/>~150ms latency
    end
```

---

## 5. 💿 Export USB pentru CDJ

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant UI as Browser UI<br/>(/drives)
    participant WA as Web App
    participant CO as Companion
    participant FS as File System
    participant USB as USB Drive

    U->>USB: insert USB
    USB->>CO: udev/IOKit/WMI event
    CO->>WA: POST /api/devices/auto-register<br/>{ type: 'drive', path, fs, capacity }
    WA->>WA: store in `drives` table
    WA-->>UI: SSE 'device-attached'
    UI->>UI: show new drive in list

    U->>UI: select playlist + click "Export to USB"
    UI->>WA: Server Action `export.toUsb({playlistId, driveId})`
    WA->>WA: load playlist tracks
    WA->>WA: generate rekordbox XML<br/>(rekordbox-xml.ts)

    loop for each track
        WA->>CO: POST /file/copy<br/>{ src, dest: USB/Contents/... }
        CO->>FS: read src
        CO->>USB: write dest (with FAT32 sanitization)
        CO-->>WA: 200 { copied: bytes }
    end

    WA->>CO: POST /file/write<br/>{ path: USB/PIONEER/rekordbox/exportData.xml }
    CO->>USB: write XML
    WA-->>UI: success { count, totalSize }
    UI->>U: toast "Export complete: 47 tracks, 312 MB"
```

---

## 6. 🔐 Autentificare (Auth.js v5 + OAuth)

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant BR as Browser
    participant WA as Web App
    participant OA as OAuth Provider<br/>(Google, etc.)
    participant DB as Drizzle DB

    U->>BR: click "Sign in with Google"
    BR->>WA: GET /api/auth/signin/google
    WA-->>BR: 302 → google.com/oauth?...
    BR->>OA: OAuth flow
    OA-->>BR: 302 → /api/auth/callback/google?code=...
    BR->>WA: GET /api/auth/callback/google?code
    WA->>OA: POST /token (exchange code)
    OA-->>WA: { access_token, id_token }
    WA->>DB: SELECT user WHERE email = ...
    alt User exists
        WA->>DB: UPDATE user (lastLogin)
    else New user
        WA->>DB: INSERT user, account
    end
    WA->>DB: INSERT session
    WA-->>BR: Set-Cookie: next-auth.session-token<br/>302 → /
    BR->>WA: GET /
    WA->>DB: SELECT session WHERE token=...
    WA-->>BR: HTML (autenticat)
```

---

## 7. 🔄 Companion auto-update

```mermaid
sequenceDiagram
    autonumber
    participant CO as Companion (running)
    participant GH as GitHub Releases
    participant U as User
    participant FS as File System

    Note over CO: la pornire +<br/>la fiecare 24h
    CO->>GH: GET /repos/dragoscv/mmo/releases/latest<br/>(via electron-updater)
    GH-->>CO: { tag_name: 'v0.3.5', assets: [...] }
    CO->>CO: compare semver(currentVersion, latestVersion)
    alt Update disponibil
        CO->>GH: GET asset (DMG/EXE/AppImage)
        GH-->>CO: download bytes
        CO->>FS: write to temp
        CO->>U: notification "Update ready, restart?"
        U->>CO: click "Restart now"
        CO->>FS: replace install + relaunch
    else Up-to-date
        CO->>CO: log "no update"
    end
```

---

## 🔗 Următorul pas

→ [05 — Securitate & Auth](05-securitate-auth.md): cum protejăm datele și ce limite punem.

---

[← 03](03-stack-tehnologic.md) · [05 →](05-securitate-auth.md)
