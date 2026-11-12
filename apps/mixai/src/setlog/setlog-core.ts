/**
 * Pure pieces of the set tracklist store (no zustand, no DOM; tested by setlog-core.test.ts):
 * deck snapshot → logger observation, the saved set and its defensive parser, file names,
 * the sampling gate and the counted-noun key.
 */
import type { DeckState } from "../bridge/types.ts";
import { SetLogger, removeEntry, trackKey, type DeckObs, type Entry, type LoggerConfig } from "./set-logger.ts";

/** localStorage key of the last recorded set. */
export const STORAGE_KEY = "mixai-setlog";
export const STORAGE_VERSION = 1;
/** More entries than any real set has (12 h at one track a minute is 720): junk beyond it is dropped. */
export const MAX_ENTRIES = 1000;
const MAX_TEXT = 300;
/** The logger is fed at most this often (the engine snapshot arrives ~30 times a second). */
export const SAMPLE_GAP_MS = 250;
/** While a recording runs, the set is written to storage at least this often (a crash or a closed window loses less). */
export const PERSIST_GAP_MS = 60_000;

/** The last recorded set, as kept between sessions. */
export interface SavedSet {
    /** Start of the recording, epoch ms. */
    startedAt: number;
    /** Length of the recording in seconds (while it still runs: up to the last change). */
    lengthSec: number;
    /** File name of the WAV (no folder), or null when it is not known. */
    file: string | null;
    entries: Entry[];
}

type DeckLike = Pick<DeckState, "id" | "loaded" | "playing" | "volume" | "crossfaderAssign" | "trackId" | "title" | "artist" | "duration">;

/** What the logger needs to know about each deck of an engine snapshot. */
export function decksToObs(decks: readonly DeckLike[]): DeckObs[] {
    return decks.map((d) => ({
        deck: d.id,
        playing: d.playing,
        volume: d.volume,
        side: d.crossfaderAssign === "a" || d.crossfaderAssign === "b" ? d.crossfaderAssign : "thru",
        track: d.loaded ? { id: trackKey(d), title: (d.title ?? "").trim(), artist: (d.artist ?? "").trim() } : null,
    }));
}

/** File name of a Windows or POSIX path ("C:\\sets\\a.wav" → "a.wav"); null for nothing usable. */
export function fileName(path: unknown): string | null {
    if (typeof path !== "string") return null;
    const name = path.split(/[\\/]/).pop()?.trim() ?? "";
    return name.length > 0 ? name.slice(0, MAX_TEXT) : null;
}

/** True when a sample taken at `last` (ms, 0 = never) is old enough for the next one at `now`. */
export function sampleDue(last: number, now: number, gap = SAMPLE_GAP_MS): boolean {
    return last <= 0 || now - last >= gap || now < last;
}

/**
 * The clock of one recording: wall-clock milliseconds that ADVANCE WITH A MONOTONIC TIMER
 * (`performance.now()`), so a change of the system clock in the middle of a set (time sync, a
 * manual correction) neither stops the logger nor moves the stamps away from the WAV.
 * `wallNow` / `monoNow` are both clocks read at the same instant, when the log begins.
 */
export function sessionClock(startedAt: number, wallNow: number, monoNow: number): (mono: number) => number {
    const elapsed = Number.isFinite(wallNow - startedAt) ? Math.max(0, wallNow - startedAt) : 0;
    const offset = startedAt + elapsed - monoNow;
    return (mono) => offset + mono;
}

/**
 * The set that is kept when a recording ends. A recording that listed no track (a sound check,
 * REC pressed by mistake) does not replace an earlier set that still has its tracklist.
 */
export function keptAtEnd(done: SavedSet, previous: SavedSet | null): SavedSet {
    return done.entries.length === 0 && previous !== null && previous.entries.length > 0 ? previous : done;
}

/** True when the running set may overwrite what storage holds: it has a track, or there is no earlier tracklist to lose. */
export function mayPersist(running: SavedSet, previous: SavedSet | null): boolean {
    return running.entries.length > 0 || previous === null || previous.entries.length === 0;
}

const DECKS: ReadonlySet<string> = new Set(["a", "b", "c", "d"]);

function text(v: unknown): string | null {
    return typeof v === "string" ? v.slice(0, MAX_TEXT) : null;
}

function seconds(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function parseEntry(raw: unknown): Entry | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const t = r.track;
    if (!t || typeof t !== "object" || Array.isArray(t)) return null;
    const tr = t as Record<string, unknown>;
    const id = text(tr.id);
    const title = text(tr.title);
    const artist = text(tr.artist);
    const startSec = seconds(r.startSec);
    const playedSec = seconds(r.playedSec);
    if (id === null || id === "" || title === null || artist === null || startSec === null || playedSec === null) return null;
    if (typeof r.deck !== "string" || !DECKS.has(r.deck)) return null;
    return { track: { id, title, artist }, deck: r.deck, startSec, playedSec };
}

/**
 * Parse what localStorage holds. Anything that is not a saved set of this version gives null;
 * inside a set, malformed entries are dropped one by one and the list is capped.
 */
export function parseSavedSet(raw: unknown): SavedSet | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r.v !== STORAGE_VERSION) return null;
    const startedAt = r.startedAt;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return null;
    const entries: Entry[] = [];
    if (Array.isArray(r.entries)) {
        for (const e of r.entries) {
            if (entries.length >= MAX_ENTRIES) break;
            const p = parseEntry(e);
            if (p) entries.push(p);
        }
    }
    return { startedAt, lengthSec: seconds(r.lengthSec) ?? 0, file: fileName(r.file), entries };
}

/** The JSON kept in localStorage. */
export function serializeSavedSet(set: SavedSet): string {
    return JSON.stringify({ v: STORAGE_VERSION, startedAt: set.startedAt, lengthSec: set.lengthSec, file: set.file, entries: set.entries.slice(0, MAX_ENTRIES) });
}

/** A saved set without entry `index` (the previous entry absorbs its time); the same object when the index is out of range. */
export function withoutEntry(set: SavedSet, index: number): SavedSet {
    const entries = removeEntry(set.entries, index);
    return entries === set.entries ? set : { ...set, entries };
}

/** True when two entry lists show the same rows (track, deck and start; the time on air may differ). */
export function sameRows(a: readonly Entry[], b: readonly Entry[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        const y = b[i]!;
        if (x.track.id !== y.track.id || x.deck !== y.deck || x.startSec !== y.startSec) return false;
    }
    return true;
}

/**
 * One recording: the logger plus what is saved about the set. Time comes in as wall-clock
 * milliseconds (`Date.now()`); the logger gets seconds since the recording started.
 */
export class SetSession {
    readonly startedAt: number;
    readonly file: string | null;
    private readonly logger: SetLogger;
    private shown: Entry[] = [];
    /** Length of the recording, fixed by `finish`. */
    private stoppedAt = 0;

    constructor(startedAt: number, file: string | null, cfg: Partial<LoggerConfig> = {}) {
        this.startedAt = startedAt;
        this.file = file;
        this.logger = new SetLogger(cfg);
    }

    private sec(now: number): number {
        return (now - this.startedAt) / 1000;
    }

    /** The set as it stands at `now`. */
    snapshot(now: number): SavedSet {
        this.shown = this.logger.entries();
        const length = this.logger.isStopped ? this.stoppedAt : Math.max(0, this.sec(now), this.logger.lastTime);
        return { startedAt: this.startedAt, lengthSec: Number.isFinite(length) ? length : 0, file: this.file, entries: this.shown };
    }

    /** Feed one engine snapshot. Returns the set when its rows changed (a new entry), else null. */
    sample(now: number, decks: readonly DeckLike[], crossfader: number): SavedSet | null {
        this.logger.observe(this.sec(now), decksToObs(decks), crossfader);
        return sameRows(this.shown, this.logger.entries()) ? null : this.snapshot(now);
    }

    /** Remove entry `index`; the set when something was removed, else null. */
    remove(index: number, now: number): SavedSet | null {
        return this.logger.remove(index) ? this.snapshot(now) : null;
    }

    /** End of the recording: closes the last entry and fixes the length. */
    finish(now: number): SavedSet {
        const end = Math.max(0, this.sec(now), this.logger.lastTime);
        this.logger.stop(end);
        this.stoppedAt = Number.isFinite(end) ? end : this.logger.lastTime;
        return this.snapshot(now);
    }
}

/** Where the keyboard focus goes after row `index` was removed and `countAfter` rows are left: the row that took its place, else the last one, else null (list empty). */
export function focusAfterRemove(index: number, countAfter: number): number | null {
    if (countAfter <= 0) return null;
    return Math.min(Math.max(0, index), countAfter - 1);
}

export type PluralForm = "one" | "few" | "other";
export type TracksKey = `setlog.tracksN.${PluralForm}`;

/**
 * Catalogue key of "`n` tracks". Romanian has three forms: "1 piesă", "2 piese", "20 de piese"
 * (`Intl.PluralRules`: one / few / other); English uses one / other.
 */
export function tracksKey(n: number, locale: string): TracksKey {
    let category: string;
    try {
        category = new Intl.PluralRules(locale).select(Number.isFinite(n) ? n : 0);
    } catch {
        category = n === 1 ? "one" : "other";
    }
    return `setlog.tracksN.${category === "one" ? "one" : category === "few" ? "few" : "other"}`;
}
