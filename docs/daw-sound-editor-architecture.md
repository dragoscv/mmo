# DAW & Sound Editor — Feature Reference & Architecture

## 1. Professional DAW Feature Comparison

### Timeline / Arrangement View

| Feature | Ableton | FL Studio | Cubase | Logic Pro | Our DAW |
|---------|---------|-----------|--------|-----------|---------|
| Clip drag (horizontal) | ✅ | ✅ | ✅ | ✅ | ❌ broken |
| Clip drag (cross-track) | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Clip resize (left/right edge) | ✅ | ✅ | ✅ | ✅ | ❌ visual only |
| Draw tool (click-drag to create) | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Erase tool on timeline | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Slice tool (split at cursor) | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Clip fade handles (crossfade) | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Clip color per clip | ✅ | ✅ | ✅ | ✅ | ✅ works |
| Duplicate clip (Ctrl+D) | ✅ | ✅ | ✅ | ✅ | ✅ context menu |
| Loop/repeat clip | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Group clips | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Snap to grid | ✅ | ✅ | ✅ | ✅ | ✅ works |
| Waveform preview in clip | ✅ | ✅ | ✅ | ✅ | ✅ works |
| MIDI preview in clip | ✅ | ✅ | ✅ | ✅ | ✅ works |
| Time stretch / warp markers | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Double-click clip → detail editor | ✅ | ✅ | ✅ | ✅ | ❌ TODO |
| Multi-clip selection | ✅ | ✅ | ✅ | ✅ | ❌ missing |
| Clip gain envelope | ✅ | ✅ | ✅ | ✅ | ❌ missing |

### Sound / Audio Editor (Adobe Audition / Destructive Edit)

| Feature | Audition | Audacity | WavePad | Our App |
|---------|----------|----------|---------|---------|
| Waveform view (zoomable) | ✅ | ✅ | ✅ | ❌ new |
| Spectrogram view | ✅ | ✅ | ❌ | ❌ new |
| Spectral frequency display | ✅ | partial | ❌ | ❌ new |
| Spectral healing brush | ✅ | ❌ | ❌ | ❌ new |
| Selection tools (time, marquee, lasso) | ✅ | ✅ | ✅ | ❌ new |
| Cut/Copy/Paste | ✅ | ✅ | ✅ | ❌ new |
| Normalize | ✅ | ✅ | ✅ | ❌ new |
| Fade in/out | ✅ | ✅ | ✅ | ❌ new |
| Noise reduction / noise print | ✅ | ✅ | ❌ | ❌ new |
| Effects (EQ, reverb, comp, etc.) | ✅ | ✅ | ✅ | ❌ new |
| Time stretch / pitch shift | ✅ | ✅ | ✅ | ❌ new |
| Markers / regions | ✅ | ✅ | ✅ | ❌ new |
| Multiformat support | ✅ | ✅ | ✅ | ✅ existing |
| Undo/Redo (unlimited) | ✅ | ✅ | ✅ | ❌ new |
| Export (WAV, MP3, FLAC) | ✅ | ✅ | ✅ | partial |

---

## 2. Architecture Decision: Sound Editor

### Option A: Same page (dockview panel)
- **Pro**: Tight integration, shared state, no navigation
- **Con**: Heavy Canvas renders compete for resources, complex panel state

### Option B: Separate page (`/editor`)
- **Pro**: Isolated rendering, dedicated layout, cleaner code
- **Con**: Need to pass audio data between pages

### Option C (CHOSEN): Separate page with shared project system
- Sound Editor at `/editor` or `/editor/[clipId]`
- DAW sends clip data via URL params + localStorage project
- Editor reads audio from same `/api/audio/[id]` endpoint
- Non-destructive edits stored as an edit list (like Audition)
- DAW auto-updates when returning from editor
- Both share the same project context via localStorage

**Why**: Adobe Audition uses this pattern — double-click a clip in Multitrack view → opens in Waveform Editor. Separate concerns, shared data.

---

## 3. Sound Editor Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Sound Editor Page                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Toolbar (tools, zoom, effects, file ops)                │   │
│  ├──────┬──────────────────────────────────────────────────┤   │
│  │      │  View Switcher: [Waveform] [Spectral] [Both]     │   │
│  │      ├──────────────────────────────────────────────────┤   │
│  │ Nav  │                                                   │   │
│  │ bar  │    Main Canvas Area                               │   │
│  │ mini │    ┌─────────────────────────────────────────┐   │   │
│  │ map  │    │  Waveform / Spectrogram / Split view     │   │   │
│  │      │    │  [interactive, zoomable, scrollable]     │   │   │
│  │      │    │  Selection overlays, markers, regions    │   │   │
│  │      │    └─────────────────────────────────────────┘   │   │
│  │      ├──────────────────────────────────────────────────┤   │
│  │      │  Timeline ruler (time/samples/bars)              │   │
│  ├──────┴──────────────────────────────────────────────────┤   │
│  │  Info bar (sample rate, bit depth, duration, selection)  │   │
│  │  Level meters │ Playback controls │ Zoom controls       │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Core Modules

1. **AudioProject** — Manages the loaded audio buffer, edit history, and metadata
2. **WaveformRenderer** — Canvas-based zoomable waveform (OffscreenCanvas for perf)
3. **SpectrogramRenderer** — FFT-based frequency visualization (WebGL or Canvas)
4. **SelectionManager** — Time selection, frequency selection, marquee
5. **EffectsProcessor** — Non-destructive effect chain (Web Audio API + AudioWorklet)
6. **EditHistory** — Unlimited undo/redo with AudioBuffer snapshots (memory-efficient diffs)
7. **MarkerSystem** — Named markers and regions with color coding
8. **ExportManager** — Export to WAV/MP3/FLAC with format options

### Views

| View | Purpose |
|------|---------|
| Waveform | Standard amplitude-over-time view, dual channel |
| Spectrogram | Frequency-over-time heatmap (FFT), color-coded intensity |
| Split | Top half waveform, bottom half spectrogram |
| Both (overlay) | Spectrogram behind translucent waveform |

### Tools

| Tool | Shortcut | Description |
|------|----------|-------------|
| Time Selection | T | Select time range (like Audition) |
| Marquee | M | Rectangular selection on spectrogram |
| Razor | R | Split/cut at cursor position |
| Pencil | P | Draw waveform directly (repair clicks/pops) |
| Healing Brush | H | Spectral healing (interpolate from surrounding) |
| Zoom | Z | Click to zoom in, alt+click to zoom out |
| Hand | Space | Pan/scroll the view |

### Effects (Non-Destructive Chain)

- EQ (parametric, graphic)
- Compressor / Limiter
- Noise Reduction (noise print → spectral subtraction)
- Reverb / Delay
- Normalize / Loudness
- Fade In/Out (linear, logarithmic, cosine)
- Time Stretch / Pitch Shift
- Reverse
- Invert Phase
- DC Offset Removal
- Silence / Generate Tone

---

## 4. DAW ↔ Sound Editor Integration

### Workflow
1. User right-clicks a clip in DAW → "Edit in Sound Editor"
2. Opens `/editor?clip={clipId}&project={projectId}` in new tab
3. Sound Editor loads the audio buffer from `/api/audio/{trackId}`
4. User makes edits (non-destructive edit list stored in project)
5. When saving, edit list is stored in the clip's metadata
6. Returning to DAW, the clip auto-refreshes with applied edits
7. Edits can be undone independently in either view

### Data Flow
```
DAW Project (localStorage)
  └── tracks[].clips[]
        ├── audio.sourceUrl → /api/audio/{id}
        ├── audio.edits[] → [{type: "normalize"}, {type: "eq", params: {...}}, ...]
        └── audio.editedPeaks → Float32Array (cached after edits apply)
```

### Project Linking
- Each clip can have an `edits: EditOperation[]` array
- Sound Editor reads/writes to this array
- DAW applies edits in real-time via Web Audio effect chain
- Or "flatten" (destructive apply) → creates new AudioBuffer

---

## 5. Implementation Phases

### Phase 1: Fix DAW Timeline (CRITICAL — bugs blocking all interaction)
1. Fix moveClip passing empty trackId → pass actual trackId
2. Implement clip resize (mousedown on edge → drag → resizeClip)
3. Implement draw tool (mousedown on empty → drag → create clip)
4. Implement erase tool (click on clip → remove)
5. Implement slice tool (click on clip → split at position)
6. Implement cross-track drag (detect track via mouse Y position)
7. Add left-edge resize (change position + length simultaneously)
8. Add fade handles (in/out triangles at clip edges)
9. Add multi-clip selection (shift+click, rubber band)

### Phase 2: Sound Editor Core
1. Create `/editor` page with layout
2. Implement WaveformRenderer (Canvas, zoom, scroll)
3. Implement SpectrogramRenderer (FFT → Canvas/WebGL)
4. Implement selection tools (time range, marquee)
5. Implement playback controls with position indicator
6. Implement minimap/navigation
7. Implement markers & regions

### Phase 3: Sound Editor Effects & Editing
1. Cut/Copy/Paste with AudioBuffer manipulation
2. Normalize, fade in/out, reverse
3. Noise reduction (spectral subtraction)
4. EQ, compression, reverb as non-destructive chain
5. Undo/Redo system
6. Export with format options

### Phase 4: Integration
1. Right-click "Edit in Sound Editor" in DAW
2. Shared project data via localStorage
3. Real-time edit list application in DAW
4. Drag-and-drop files into both DAW and Editor
5. Sidebar navigation between DAW and Editor
6. Windows context menu integration (if Electron/PWA)

---

## 6. File System / Drag-and-Drop

### Browser drag-and-drop
- Handle `dragover` + `drop` events on DAW timeline and Sound Editor
- Read `DataTransfer.files` for audio files
- Create ObjectURL → decode with Web Audio API
- For DAW: create new clip on target track
- For Editor: load into editor buffer

### Windows context menu ("Send to DAW/Editor")
- **PWA approach**: Register protocol handler (`web+rekordbox://`) in manifest
- **Electron approach**: Register shell integration for audio MIME types
- Current app has `manifest.webmanifest` → PWA-capable
- Can register file associations via Web App Manifest `file_handlers`

```json
{
  "file_handlers": [
    {
      "action": "/editor",
      "accept": { "audio/*": [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"] }
    },
    {
      "action": "/daw",
      "accept": { "audio/*": [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"] }
    }
  ]
}
```
