// ═══════════════════════════════════════════════════════════════════════════
// History Engine — Named, branching undo/redo with time-travel
// ═══════════════════════════════════════════════════════════════════════════
// Generic over snapshot type T. Both DAW (project snapshots) and Sound
// Editor (AudioBuffer snapshots) use this.

export interface HistoryEntry<T> {
    id: string;
    label: string;
    icon?: string;           // lucide icon name hint (optional)
    timestamp: number;
    snapshot: T;
}

export interface HistoryState<T> {
    entries: HistoryEntry<T>[];  // all snapshots, oldest-first
    currentIndex: number;        // pointer into entries (the "present")
    maxEntries: number;
}

let _hid = 0;
function historyId() {
    return `h_${Date.now()}_${++_hid}`;
}

/** Create an empty history seeded with an initial snapshot */
export function createHistory<T>(initial: T, label = "Initial State", maxEntries = 100): HistoryState<T> {
    return {
        entries: [{
            id: historyId(),
            label,
            timestamp: Date.now(),
            snapshot: initial,
        }],
        currentIndex: 0,
        maxEntries,
    };
}

/** Push a new entry, discarding any redo-future and trimming to maxEntries */
export function pushHistory<T>(
    state: HistoryState<T>,
    snapshot: T,
    label: string,
    icon?: string,
): HistoryState<T> {
    // Discard everything after current pointer (branching)
    const kept = state.entries.slice(0, state.currentIndex + 1);

    const entry: HistoryEntry<T> = {
        id: historyId(),
        label,
        icon,
        timestamp: Date.now(),
        snapshot,
    };

    const entries = [...kept, entry];

    // Trim oldest if exceeding max (keep index 0 = initial state)
    if (entries.length > state.maxEntries) {
        const excess = entries.length - state.maxEntries;
        return {
            ...state,
            entries: entries.slice(excess),
            currentIndex: entries.length - excess - 1,
        };
    }

    return {
        ...state,
        entries,
        currentIndex: entries.length - 1,
    };
}

/** Move to previous entry */
export function undoHistory<T>(state: HistoryState<T>): HistoryState<T> {
    if (state.currentIndex <= 0) return state;
    return { ...state, currentIndex: state.currentIndex - 1 };
}

/** Move to next entry */
export function redoHistory<T>(state: HistoryState<T>): HistoryState<T> {
    if (state.currentIndex >= state.entries.length - 1) return state;
    return { ...state, currentIndex: state.currentIndex + 1 };
}

/** Jump to any entry by index */
export function jumpToHistory<T>(state: HistoryState<T>, index: number): HistoryState<T> {
    const clamped = Math.max(0, Math.min(index, state.entries.length - 1));
    return { ...state, currentIndex: clamped };
}

/** Get the current snapshot */
export function getCurrentSnapshot<T>(state: HistoryState<T>): T {
    return state.entries[state.currentIndex].snapshot;
}

/** Can undo? */
export function canUndo<T>(state: HistoryState<T>): boolean {
    return state.currentIndex > 0;
}

/** Can redo? */
export function canRedo<T>(state: HistoryState<T>): boolean {
    return state.currentIndex < state.entries.length - 1;
}

/** Number of available undo steps */
export function undoCount<T>(state: HistoryState<T>): number {
    return state.currentIndex;
}

/** Number of available redo steps */
export function redoCount<T>(state: HistoryState<T>): number {
    return state.entries.length - 1 - state.currentIndex;
}

/** Clear future (redo) entries without changing current */
export function clearFuture<T>(state: HistoryState<T>): HistoryState<T> {
    return {
        ...state,
        entries: state.entries.slice(0, state.currentIndex + 1),
    };
}

/** Reset history to a single initial entry */
export function resetHistory<T>(snapshot: T, label = "Initial State"): HistoryState<T> {
    return createHistory(snapshot, label);
}
