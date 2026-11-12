/**
 * Automatic tracklist of a recorded set (WP19-27, step 1): a TypeScript port of the rule in
 * `src-tauri/crates/decks-setlog/src/lib.rs`, kept pure (no store, no DOM) so `node --test`
 * covers it and the crate's scenarios can be replayed with the same numbers.
 *
 * Rule: the audible level of a deck = playing × channel fader × crossfader side. The loudest
 * audible track that has been dominant for `minDominantSec` (20 s) becomes an entry, backdated
 * to when it became dominant, so previews, cue checks and short blends never make the list.
 * `stop` closes the last entry; `remove(index)` gives the removed entry's time to the previous
 * one. Time is seconds since the recording started and must not go backwards: a non-finite or
 * earlier sample is ignored.
 *
 * Differences from the crate: the crossfader side comes from the deck's own assignment
 * (`DeckState.crossfaderAssign`, "a" | "thru" | "b") instead of the deck index, and a track
 * without an id gets a stable key from title, artist and duration (`trackKey`). Two additions:
 * removing the entry of the track that is STILL the dominant one keeps it out until another
 * track (or silence) takes over (by the crate's rule alone the next sample would list it again);
 * and the same track taking over on ANOTHER deck (a DJ doubling a track) continues its entry
 * instead of adding a second identical line (the crate compares track and deck).
 */

export type Side = "a" | "thru" | "b";

/** What the logger knows about a loaded track. */
export interface TrackRef {
    /** Stable key: the engine's track id, or `trackKey()` of title / artist / duration. */
    id: string;
    title: string;
    artist: string;
}

/** One deck at one instant. */
export interface DeckObs {
    /** Deck letter ("a".."d"); ties between equally loud decks go to the first letter. */
    deck: string;
    playing: boolean;
    /** Channel fader 0..1. */
    volume: number;
    side: Side;
    track: TrackRef | null;
}

/** A tracklist entry. */
export interface Entry {
    track: TrackRef;
    deck: string;
    /** Seconds from the start of the recording when it became the dominant track. */
    startSec: number;
    /** Seconds it was the dominant track (provisional for the last entry until `stop`). */
    playedSec: number;
}

export interface LoggerConfig {
    /** A track must dominate this long to become an entry. */
    minDominantSec: number;
    /** Audible level below this counts as silent. */
    audibleThreshold: number;
}

export const DEFAULT_CONFIG: LoggerConfig = { minDominantSec: 20, audibleThreshold: 0.05 };

/** The crossfader range of the mixer store and the engine: −1 = A only, +1 = B only. */
export const XF_MIN = -1;
export const XF_MAX = 1;

/**
 * Crossfader weight of a deck on `side` for crossfader position `x` in −1..1 (the mixer store's
 * own range; a value outside it is clamped). Linear, full in the middle; "thru" bypasses it.
 */
export function crossfaderWeight(side: Side, x: number): number {
    const c = Number.isFinite(x) ? Math.min(XF_MAX, Math.max(XF_MIN, x)) : 0;
    switch (side) {
        case "a":
            return Math.min(1 - c, 1);
        case "b":
            return Math.min(1 + c, 1);
        default:
            return 1;
    }
}

/**
 * Stable key of a track: its id when it has one, else title, artist and duration (rounded to
 * the second) joined with a separator no title contains. Two loads of the same file give the
 * same key; two different id-less tracks with the same title differ by artist or length.
 */
export function trackKey(t: { trackId?: string | null; title?: string | null; artist?: string | null; duration?: number | null }): string {
    if (t.trackId) return t.trackId;
    const d = Number.isFinite(t.duration ?? Number.NaN) ? Math.round(t.duration as number) : 0;
    return `k:${(t.title ?? "").trim()}\u001f${(t.artist ?? "").trim()}\u001f${d}`;
}

/** Audible level of one deck: playing × channel fader × crossfader side (0 when paused or empty). */
export function audibleLevel(d: DeckObs, crossfader: number): number {
    if (!d.track || !d.playing) return 0;
    const v = Number.isFinite(d.volume) ? Math.min(1, Math.max(0, d.volume)) : 0;
    return v * crossfaderWeight(d.side, crossfader);
}

/** The loudest audible deck at or above `threshold`; equal levels go to the first deck letter (the crate: lower index). */
export function dominantOf(decks: readonly DeckObs[], crossfader: number, threshold: number): DeckObs | null {
    let best: DeckObs | null = null;
    let bestLevel = 0;
    for (const d of decks) {
        const level = audibleLevel(d, crossfader);
        if (level < threshold) continue;
        if (best === null || level > bestLevel || (level === bestLevel && d.deck < best.deck)) {
            best = d;
            bestLevel = level;
        }
    }
    return best;
}

/**
 * Remove entry `index` from a finished or provisional list: the previous entry absorbs its
 * time. Returns the same array when the index is out of range.
 */
export function removeEntry(entries: readonly Entry[], index: number): Entry[] {
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) return entries as Entry[];
    const gone = entries[index]!;
    const out = entries.filter((_, i) => i !== index).map((e) => ({ ...e }));
    const prev = out[index - 1];
    if (index > 0 && prev) prev.playedSec += gone.playedSec;
    return out;
}

interface Streak {
    id: string;
    deck: string;
    since: number;
    track: TrackRef;
}

/** Builds the tracklist while the set is recorded. */
export class SetLogger {
    private readonly cfg: LoggerConfig;
    private readonly list: Entry[] = [];
    private streak: Streak | null = null;
    /** The running streak was removed by hand: it is not listed again until the dominant track changes. */
    private dismissed = false;
    private lastT = 0;
    private stopped = false;

    constructor(cfg: Partial<LoggerConfig> = {}) {
        this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    }

    /** Feed the state at `tSec` (seconds since the recording started, non-decreasing). */
    observe(tSec: number, decks: readonly DeckObs[], crossfader: number): void {
        if (this.stopped || !Number.isFinite(tSec) || tSec < this.lastT) return;
        this.lastT = tSec;
        const d = dominantOf(decks, crossfader, this.cfg.audibleThreshold);
        if (!d || !d.track) {
            this.streak = null;
            this.dismissed = false;
            return;
        }
        const same = this.streak !== null && this.streak.id === d.track.id && this.streak.deck === d.deck;
        if (!same) {
            // A track removed by hand stays out while it is the one on air, also when it moves to another deck.
            if (this.streak === null || this.streak.id !== d.track.id) this.dismissed = false;
            this.streak = { id: d.track.id, deck: d.deck, since: tSec, track: d.track };
        }
        const s = this.streak!;
        const last = this.list[this.list.length - 1];
        // The track of the last entry is still the one on air, on whichever deck it plays now.
        const isCurrent = last !== undefined && last.track.id === s.id;
        if (!isCurrent && !this.dismissed && tSec - s.since >= this.cfg.minDominantSec) {
            if (last) last.playedSec = Math.max(0, s.since - last.startSec);
            this.list.push({ track: s.track, deck: s.deck, startSec: s.since, playedSec: 0 });
        }
    }

    /** End of the set: closes the last entry. */
    stop(tSec: number): void {
        if (this.stopped) return;
        const end = Math.max(Number.isFinite(tSec) ? tSec : 0, this.lastT);
        const last = this.list[this.list.length - 1];
        if (last) last.playedSec = Math.max(0, end - last.startSec);
        this.stopped = true;
    }

    get isStopped(): boolean {
        return this.stopped;
    }

    /** Last sample time (seconds). */
    get lastTime(): number {
        return this.lastT;
    }

    /** Entries so far (the last one's `playedSec` is provisional until `stop`). */
    entries(): Entry[] {
        const v = this.list.map((e) => ({ ...e, track: { ...e.track } }));
        const last = v[v.length - 1];
        if (!this.stopped && last) last.playedSec = Math.max(0, this.lastT - last.startSec);
        return v;
    }

    /** Manual edit: remove an entry (a wrongly detected track); the previous one absorbs its time. */
    remove(index: number): boolean {
        if (!Number.isInteger(index) || index < 0 || index >= this.list.length) return false;
        const gone = this.list[index]!;
        const s = this.streak;
        // The entry of the track that is on air right now: keep it out while that track stays dominant.
        if (!this.stopped && index === this.list.length - 1 && s !== null && s.id === gone.track.id) this.dismissed = true;
        const next = removeEntry(this.list, index);
        this.list.splice(0, this.list.length, ...next);
        return true;
    }
}
