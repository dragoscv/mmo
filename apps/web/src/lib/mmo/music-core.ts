/**
 * Pure music helpers (WP16-40) shared by the web music engine (`web-music-player.ts`) and the music UI:
 * shuffle order, next/previous index per repeat mode, queue reorder/remove index maths, play-count
 * threshold, LRC parsing + current-line lookup, clock formatting. No DOM, no React: unit-tested in
 * `music-core.test.ts`.
 */
import type { LyricLine, RepeatMode, TrackCard } from "./media-types";

/** Server play key for a track id (`tr_<n>`). */
export function trackKeyOf(id: string): string {
    return /^tr_\d+$/.test(id) ? id : `tr_${id}`;
}

/** Fisher–Yates; `rand` is injectable for tests. Never mutates the input. */
export function shuffleOrder<T>(items: readonly T[], rand: () => number = Math.random): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = out[i] as T;
        out[i] = out[j] as T;
        out[j] = tmp;
    }
    return out;
}

/** Item at `first` stays at the head, the rest is shuffled behind it (shuffle-on while a track plays). */
export function shuffleKeepFirst<T>(items: readonly T[], first: number, rand: () => number = Math.random): T[] {
    if (items.length === 0) return [];
    const f = Math.max(0, Math.min(first, items.length - 1));
    const head = items[f] as T;
    return [head, ...shuffleOrder(items.filter((_, i) => i !== f), rand)];
}

/**
 * Index to play after `index`. `auto` = the track ended by itself (repeat-one replays it; a manual "next"
 * always advances). `null` = end of queue, stop.
 */
export function nextIndex(index: number, length: number, repeat: RepeatMode, auto: boolean): number | null {
    if (length <= 0) return null;
    if (auto && repeat === "one") return Math.max(0, index);
    const n = index + 1;
    if (n >= length) return repeat === "all" ? 0 : null;
    return n;
}

/** "restart" = seek the current track to 0 (more than 3 s in, or nothing before it). */
export function prevIndex(index: number, length: number, repeat: RepeatMode, positionSec: number): number | "restart" {
    if (positionSec > 3 || length <= 0) return "restart";
    if (index > 0) return index - 1;
    if (repeat === "all" && length > 1) return length - 1;
    return "restart";
}

export function cycleRepeat(r: RepeatMode): RepeatMode {
    return r === "off" ? "all" : r === "all" ? "one" : "off";
}

/** Returns a new array with the item at `from` moved to `to` (both clamped). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
    const out = items.slice();
    if (from < 0 || from >= out.length) return out;
    const t = Math.max(0, Math.min(to, out.length - 1));
    const [it] = out.splice(from, 1);
    out.splice(t, 0, it as T);
    return out;
}

/** Where the playing index ends up after `moveItem(from, to)`. */
export function indexAfterMove(current: number, from: number, to: number): number {
    if (current === from) return to;
    if (from < current && to >= current) return current - 1;
    if (from > current && to <= current) return current + 1;
    return current;
}

/** Playing index after removing `removed` (when it is not the playing one). */
export function indexAfterRemove(current: number, removed: number): number {
    return removed < current ? current - 1 : current;
}

/** A play counts after 30 s or half the track, whichever comes first. */
export function playThresholdSec(durationSec: number): number {
    return durationSec > 0 ? Math.min(30, durationSec * 0.5) : 30;
}

// ─── LRC ────────────────────────────────────────────────────────────────────

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

export function looksLikeLrc(text: string | null | undefined): boolean {
    if (!text) return false;
    return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text);
}

/**
 * Parses LRC (`[mm:ss.xx]text`, several time tags per line, `[offset:±ms]`); metadata tags are ignored.
 * Returns lines sorted by time; empty text is kept (instrumental gap).
 */
export function parseLrc(text: string): LyricLine[] {
    const out: LyricLine[] = [];
    let offset = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const off = OFFSET_TAG.exec(line);
        if (off) { offset = Number(off[1]); continue; }
        const times: number[] = [];
        TIME_TAG.lastIndex = 0;
        let m: RegExpExecArray | null;
        let end = 0;
        while ((m = TIME_TAG.exec(line)) && m.index === end) {
            const min = Number(m[1]);
            const sec = Number(m[2]);
            const frac = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
            times.push(min * 60_000 + sec * 1000 + frac);
            end = TIME_TAG.lastIndex;
        }
        if (times.length === 0) continue;
        const body = line.slice(end).trim();
        for (const t of times) out.push({ timeMs: Math.max(0, t - offset), text: body });
    }
    return out.sort((a, b) => a.timeMs - b.timeMs);
}

/** Index of the line active at `ms` (binary search; -1 before the first line). */
export function currentLineIndex(lines: readonly LyricLine[], ms: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((lines[mid] as LyricLine).timeMs <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

// ─── formatting ─────────────────────────────────────────────────────────────

/** `m:ss` / `h:mm:ss`. */
export function fmtClock(sec: number): string {
    const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function totalSeconds(tracks: readonly Pick<TrackCard, "durationSec">[]): number {
    return tracks.reduce((s, t) => s + (t.durationSec || 0), 0);
}

/** Next may hand route params over still percent-encoded; decode once, tolerating a literal `%`. */
export function safeDecode(v: string): string {
    try { return decodeURIComponent(v); } catch { return v; }
}

/** A–Z index used by the artist/album tabs (`#` = digits and symbols, matching the server). */
export const MUSIC_LETTERS: readonly string[] = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** Groups tracks by disc, preserving order; single-disc albums return one group with `disc: null`. */
export function discGroups(tracks: readonly TrackCard[]): { disc: number | null; items: { track: TrackCard; index: number }[] }[] {
    const discs = new Set(tracks.map((t) => t.disc ?? 1));
    if (discs.size <= 1) return [{ disc: null, items: tracks.map((track, index) => ({ track, index })) }];
    const groups: { disc: number | null; items: { track: TrackCard; index: number }[] }[] = [];
    tracks.forEach((track, index) => {
        const d = track.disc ?? 1;
        let g = groups[groups.length - 1];
        if (!g || g.disc !== d) { g = { disc: d, items: [] }; groups.push(g); }
        g.items.push({ track, index });
    });
    return groups;
}
