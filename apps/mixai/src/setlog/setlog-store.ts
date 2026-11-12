/**
 * Automatic tracklist of the recorded set (WP19-27, step 1).
 *
 * While the master recording runs (`useRecordingStore`), the engine snapshots of `useMixerStore`
 * feed a `SetSession` (setlog-core.ts → set-logger.ts), at most four times a second (the last
 * change is always sampled, so a pause is never missed). When the recording stops the set is
 * closed.
 *
 * Time is the start of the recording plus a MONOTONIC timer (`sessionClock`): a change of the
 * system clock during a set neither stops the logger nor moves the stamps away from the WAV.
 *
 * The store changes only when a ROW changes (a new entry, a removal, start, stop, clear): the
 * 30 Hz snapshots render nothing. The last set (start, length, WAV file name, entries) is kept in
 * localStorage `mixai-setlog`, so it can be uploaded the next day. A new recording replaces it
 * when it lists its FIRST track: a sound check, or REC pressed by mistake, loses nothing. While
 * a recording runs the set is also written once a minute and when the window goes away, so a
 * crash or a closed app keeps the length and the tracks so far.
 */
import { create } from "zustand";
import { useMixerStore } from "@/state/mixer-store";
import { useRecordingStore } from "@/state/recording-store";
import { devExpose } from "@/dev/expose";
import {
    PERSIST_GAP_MS,
    SAMPLE_GAP_MS,
    STORAGE_KEY,
    SetSession,
    fileName,
    keptAtEnd,
    mayPersist,
    parseSavedSet,
    sampleDue,
    serializeSavedSet,
    sessionClock,
    withoutEntry,
    type SavedSet,
} from "./setlog-core.ts";

function load(): SavedSet | null {
    try {
        return parseSavedSet(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
    } catch {
        return null;
    }
}

function persist(set: SavedSet | null): void {
    try {
        if (set) localStorage.setItem(STORAGE_KEY, serializeSavedSet(set));
        else localStorage.removeItem(STORAGE_KEY);
    } catch {
        // storage unavailable: the list still works for this session
    }
}

interface SetlogStore {
    /** The set being recorded, or the last recorded one; null = nothing saved. */
    set: SavedSet | null;
    /** True while `set` is the recording that runs now. */
    recording: boolean;
    /** The tracklist popover (title bar button, command palette). */
    open: boolean;
    setOpen: (open: boolean) => void;
    /** Remove entry `index`; the previous entry absorbs its time. */
    remove: (index: number) => void;
    /** Forget the saved set (not while it is being recorded). */
    clear: () => void;
}

/** The running recording (module scope: one engine, one recording). */
let session: SetSession | null = null;
/** Wall-clock milliseconds of the running recording, driven by the monotonic timer. */
let clock: ((mono: number) => number) | null = null;
/** The set that was saved when the running recording began; null once the new one has replaced it in storage. */
let previous: SavedSet | null = null;
/** Monotonic times (ms) of the last sample and of the last write to storage. */
let lastSample = 0;
let lastPersist = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function mono(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function now(): number {
    return clock ? clock(mono()) : Date.now();
}

/** Write `set` to storage, unless it is a running recording without a track and an earlier tracklist would be lost. */
function save(set: SavedSet): void {
    if (session) {
        if (!mayPersist(set, previous)) return;
        previous = null;
    }
    persist(set);
    lastPersist = mono();
}

function publish(set: SavedSet): void {
    useSetlogStore.setState({ set });
    save(set);
}

export const useSetlogStore = create<SetlogStore>((set, get) => ({
    set: typeof localStorage === "undefined" ? null : load(),
    recording: false,
    open: false,
    setOpen: (open) => set({ open }),
    remove: (index) => {
        if (session) {
            const next = session.remove(index, now());
            if (next) publish(next);
            return;
        }
        const cur = get().set;
        if (!cur) return;
        const next = withoutEntry(cur, index);
        if (next !== cur) publish(next);
    },
    clear: () => {
        if (session) return;
        set({ set: null });
        persist(null);
    },
}));

function stopTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
}

function sampleNow(): void {
    stopTimer();
    if (!session) return;
    lastSample = mono();
    const at = now();
    const m = useMixerStore.getState();
    const next = session.sample(at, m.decks, m.crossfader);
    if (next) publish(next);
    else if (lastSample - lastPersist >= PERSIST_GAP_MS) save(session.snapshot(at));
}

/** Sample now when the last sample is old enough, else once when it will be (the latest state is never dropped). */
function sampleSoon(): void {
    const t = mono();
    if (sampleDue(lastSample, t)) sampleNow();
    else if (timer === null) timer = setTimeout(sampleNow, Math.max(0, SAMPLE_GAP_MS - (t - lastSample)));
}

function begin(startedAt: number, path: string | null): void {
    // The same recording (the effect that starts the log runs twice in StrictMode): keep it.
    if (session && session.startedAt === startedAt) return;
    stopTimer();
    previous = useSetlogStore.getState().set;
    clock = sessionClock(startedAt, Date.now(), mono());
    session = new SetSession(startedAt, fileName(path));
    lastSample = 0;
    lastPersist = mono();
    useSetlogStore.setState({ recording: true });
    publish(session.snapshot(startedAt));
    sampleNow();
}

function end(): void {
    stopTimer();
    if (!session) return;
    const kept = keptAtEnd(session.finish(now()), previous);
    session = null;
    clock = null;
    previous = null;
    useSetlogStore.setState({ recording: false, set: kept });
    persist(kept);
}

/** The window is going away (closed, reloaded): keep what the running recording has so far. */
function onPageHide(): void {
    if (session) save(session.snapshot(now()));
}

/** Log the tracklist of every recording. Returns the unsubscribe function. */
export function startSetLog(): () => void {
    const rec = useRecordingStore.getState();
    if (rec.recording && rec.startedAt > 0) begin(rec.startedAt, rec.path);
    const offRec = useRecordingStore.subscribe((s, prev) => {
        if (s.recording === prev.recording && s.startedAt === prev.startedAt) return;
        if (s.recording && s.startedAt > 0) begin(s.startedAt, s.path);
        else end();
    });
    const offMixer = useMixerStore.subscribe((s, prev) => {
        if (!session) return;
        if (s.decks === prev.decks && s.crossfader === prev.crossfader) return;
        sampleSoon();
    });
    if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);
    return () => {
        offRec();
        offMixer();
        stopTimer();
        if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    };
}

devExpose("setlog", useSetlogStore);
// The recording state, for tests that start a recording without the native save dialog.
devExpose("recording", useRecordingStore);
