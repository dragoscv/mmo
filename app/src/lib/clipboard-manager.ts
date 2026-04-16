// ═══════════════════════════════════════════════════════════════════════════
// Clipboard Manager — Multi-item, typed clipboard shared across DAW & Editor
// ═══════════════════════════════════════════════════════════════════════════

export type ClipboardItemType =
    | "daw-clips"       // One or more DAW timeline clips
    | "daw-notes"       // MIDI notes from piano roll
    | "daw-track"       // Full track (with clips)
    | "audio-buffer"    // Sound Editor audio selection
    | "automation";     // Automation lane points

export interface ClipboardEntry {
    id: string;
    type: ClipboardItemType;
    label: string;
    description: string;   // e.g. "2 clips from Audio 1" or "4 bars of audio"
    timestamp: number;
    data: unknown;          // typed externally per type
    preview?: {
        duration?: number;  // seconds
        peaks?: number[];   // mini-waveform for audio
        noteCount?: number; // for MIDI
        clipCount?: number; // for clips
    };
    pinned?: boolean;       // prevent auto-eviction
}

export interface ClipboardState {
    entries: ClipboardEntry[];
    activeIndex: number;    // which entry is "current" for paste
    maxEntries: number;
}

let _cid = 0;
function clipId() {
    return `cb_${Date.now()}_${++_cid}`;
}

const STORAGE_KEY = "daw_clipboard";

/** Load clipboard from localStorage or create empty */
export function loadClipboard(maxEntries = 20): ClipboardState {
    if (typeof window === "undefined") return createClipboard(maxEntries);
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored) as ClipboardState;
            // Audio buffers can't be serialized, filter those out
            return {
                ...parsed,
                entries: parsed.entries.filter(e => e.type !== "audio-buffer"),
                maxEntries,
            };
        }
    } catch { /* ignore */ }
    return createClipboard(maxEntries);
}

/** Save clipboard to localStorage (excluding audio buffers) */
export function saveClipboard(state: ClipboardState): void {
    if (typeof window === "undefined") return;
    try {
        const serializable: ClipboardState = {
            ...state,
            entries: state.entries.filter(e => e.type !== "audio-buffer"),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
    } catch { /* ignore storage full */ }
}

/** Create an empty clipboard */
export function createClipboard(maxEntries = 20): ClipboardState {
    return { entries: [], activeIndex: -1, maxEntries };
}

/** Add an item to the clipboard (becomes active/current) */
export function addToClipboard(
    state: ClipboardState,
    type: ClipboardItemType,
    label: string,
    description: string,
    data: unknown,
    preview?: ClipboardEntry["preview"],
): ClipboardState {
    const entry: ClipboardEntry = {
        id: clipId(),
        type,
        label,
        description,
        timestamp: Date.now(),
        data,
        preview,
    };

    // New item goes to front (most recent)
    let entries = [entry, ...state.entries];

    // Trim unpinned items if over limit
    if (entries.length > state.maxEntries) {
        // Remove oldest unpinned
        const pinned = entries.filter(e => e.pinned);
        const unpinned = entries.filter(e => !e.pinned);
        const kept = unpinned.slice(0, state.maxEntries - pinned.length);
        entries = [...kept.slice(0, 1), ...pinned, ...kept.slice(1)];
        // Re-sort by timestamp desc
        entries.sort((a, b) => b.timestamp - a.timestamp);
        entries = entries.slice(0, state.maxEntries);
    }

    return { ...state, entries, activeIndex: 0 };
}

/** Remove an item from clipboard */
export function removeFromClipboard(state: ClipboardState, id: string): ClipboardState {
    const entries = state.entries.filter(e => e.id !== id);
    let activeIndex = state.activeIndex;
    if (activeIndex >= entries.length) activeIndex = entries.length - 1;
    return { ...state, entries, activeIndex };
}

/** Toggle pin on an item */
export function togglePinClipboard(state: ClipboardState, id: string): ClipboardState {
    return {
        ...state,
        entries: state.entries.map(e => e.id === id ? { ...e, pinned: !e.pinned } : e),
    };
}

/** Set active item index (for paste) */
export function setActiveClipboard(state: ClipboardState, index: number): ClipboardState {
    return { ...state, activeIndex: Math.max(-1, Math.min(index, state.entries.length - 1)) };
}

/** Get the active entry (or null) */
export function getActiveEntry(state: ClipboardState): ClipboardEntry | null {
    if (state.activeIndex < 0 || state.activeIndex >= state.entries.length) return null;
    return state.entries[state.activeIndex];
}

/** Clear all unpinned items */
export function clearClipboard(state: ClipboardState): ClipboardState {
    const entries = state.entries.filter(e => e.pinned);
    return { ...state, entries, activeIndex: entries.length > 0 ? 0 : -1 };
}

/** Get display info for a clipboard item type */
export function getTypeLabel(type: ClipboardItemType): string {
    switch (type) {
        case "daw-clips": return "Clips";
        case "daw-notes": return "MIDI Notes";
        case "daw-track": return "Track";
        case "audio-buffer": return "Audio";
        case "automation": return "Automation";
    }
}

/** Get icon hint for clipboard item type */
export function getTypeIcon(type: ClipboardItemType): string {
    switch (type) {
        case "daw-clips": return "Layers";
        case "daw-notes": return "Music";
        case "daw-track": return "AudioWaveform";
        case "audio-buffer": return "Waves";
        case "automation": return "TrendingUp";
    }
}
