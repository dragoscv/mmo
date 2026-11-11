/**
 * Pure view logic of the library table: sorting, the "matches deck" / "not played" /
 * favourites filters, which columns fit a given width, row geometry and small formatters.
 * No DOM, no React, no store: unit-tested with `node --test` (track-view.test.ts).
 */
import type { DeckId, LibraryTrack } from "../bridge/types.ts";
import { parseCamelot, transitionScore, type TransitionScore } from "../lib/harmonic.ts";

// ─── Sorting ────────────────────────────────────────────────────────────────

/** Sort keys the companion understands (`GET /library/tracks?sort=`). */
export const SORT_KEYS = ["title", "artist", "bpm", "key", "energy", "duration", "genre", "addedAt", "rating", "favorite"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export interface SortState {
    key: SortKey;
    dir: SortDir;
}

/** The companion's own default: newest first. */
export const DEFAULT_SORT: SortState = { key: "addedAt", dir: "desc" };

const DESC_FIRST: ReadonlySet<SortKey> = new Set<SortKey>(["addedAt", "rating", "favorite", "energy"]);

/** Header click: a new column starts in its natural direction, the same column flips. */
export function nextSort(cur: SortState | null, key: SortKey): SortState {
    if (cur && cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
    return { key, dir: DESC_FIRST.has(key) ? "desc" : "asc" };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function sortValue(t: LibraryTrack, key: SortKey): string | number | null {
    switch (key) {
        case "title":
            return (t.title ?? t.filename).trim();
        case "artist":
            return t.artist?.trim() || null;
        case "genre":
            return t.genre?.trim() || null;
        case "addedAt":
            return t.addedAt ?? null;
        case "bpm":
            return t.bpm && t.bpm > 0 ? t.bpm : null;
        case "energy":
            return t.energy ?? null;
        case "duration":
            return t.duration && t.duration > 0 ? t.duration : null;
        case "rating":
            return t.rating ?? null;
        case "favorite":
            return t.isFavorite ? 1 : 0;
        case "key": {
            // Camelot order (1A, 1B, 2A … 12B), not text order ("10A" < "8A").
            const k = parseCamelot(t.keyCamelot);
            return k ? k.number * 2 + (k.letter === "B" ? 1 : 0) : null;
        }
    }
}

/** Unknown values always sort last; ties fall back to the id so the order is stable. */
export function compareTracks(a: LibraryTrack, b: LibraryTrack, sort: SortState): number {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    const sign = sort.dir === "asc" ? 1 : -1;
    if (va === null || vb === null) {
        if (va !== null) return -1;
        if (vb !== null) return 1;
        return (a.id - b.id) * sign;
    }
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
    return c !== 0 ? c * sign : (a.id - b.id) * sign;
}

export function sortTracks(tracks: readonly LibraryTrack[], sort: SortState): LibraryTrack[] {
    return [...tracks].sort((a, b) => compareTracks(a, b, sort));
}

// ─── Filters ────────────────────────────────────────────────────────────────

/** Tempo window of the "matches deck" filter, in percent of the deck's current BPM. */
export const BPM_WINDOW_PCT = 6;

/** The deck tempo a track would be matched to: the deck's BPM, or its half / double when closer. */
function matchTarget(trackBpm: number, refBpm: number): number {
    let best = refBpm;
    for (const c of [refBpm * 2, refBpm / 2]) if (Math.abs(trackBpm - c) < Math.abs(trackBpm - best)) best = c;
    return best;
}

/** Pitch change (signed %, relative to the track) that brings `trackBpm` onto `refBpm`; null when unknown. */
export function bpmDiffPct(trackBpm: number | null | undefined, refBpm: number): number | null {
    if (!trackBpm || !(trackBpm > 0) || !(refBpm > 0)) return null;
    return ((matchTarget(trackBpm, refBpm) - trackBpm) / trackBpm) * 100;
}

/** True when `trackBpm` is within ±`BPM_WINDOW_PCT` % of the deck's BPM (half / double time allowed). */
export function withinBpmWindow(trackBpm: number | null | undefined, refBpm: number): boolean {
    if (!trackBpm || !(trackBpm > 0) || !(refBpm > 0)) return false;
    const target = matchTarget(trackBpm, refBpm);
    return Math.abs(trackBpm - target) / target <= BPM_WINDOW_PCT / 100 + 1e-9;
}

export interface Ranked {
    t: LibraryTrack;
    match: TransitionScore | null;
}

/** The deck a match filter compares against. */
export interface MatchRef {
    /** Camelot key of the deck's track, null when unknown. */
    key: string | null;
    /** Current BPM of the deck (track BPM × tempo), 0 when unknown. */
    bpm: number;
    /** Track on that deck (it never matches itself). */
    trackId: string | null;
}

/**
 * "Matches deck": tracks whose key is compatible AND whose tempo is inside the window, each with
 * its transition score. A criterion the deck cannot provide (unknown key or BPM) is skipped; with
 * neither known nothing matches. `keyOk(trackKey)` = compatible with the deck key (null = unknown).
 * Input order is kept; sort with `byScore` for "best first".
 */
export function rankMatches(tracks: readonly LibraryTrack[], ref: MatchRef, keyOk: (trackKey: string | null) => boolean | null): Ranked[] {
    const refKey = parseCamelot(ref.key);
    const hasBpm = ref.bpm > 0;
    if (!refKey && !hasBpm) return [];
    const out: Ranked[] = [];
    for (const t of tracks) {
        if (ref.trackId !== null && String(t.id) === ref.trackId) continue;
        if (refKey && keyOk(t.keyCamelot) !== true) continue;
        if (hasBpm && !withinBpmWindow(t.bpm, ref.bpm)) continue;
        out.push({ t, match: transitionScore({ key: refKey, bpm: ref.bpm }, { key: parseCamelot(t.keyCamelot), bpm: t.bpm ?? 0 }) });
    }
    return out;
}

export function byScore(a: Ranked, b: Ranked): number {
    return (b.match?.score ?? 0) - (a.match?.score ?? 0);
}

export interface TrackFilters {
    favorites: boolean;
    notPlayed: boolean;
}

/** Favourites / "not played tonight"; `isPlayed(trackId)` comes from the play history. */
export function filterTracks(tracks: readonly LibraryTrack[], f: TrackFilters, isPlayed: (trackId: string) => boolean): LibraryTrack[] {
    if (!f.favorites && !f.notPlayed) return tracks as LibraryTrack[];
    return tracks.filter((t) => (!f.favorites || t.isFavorite === true) && (!f.notPlayed || !isPlayed(String(t.id))));
}

// ─── Decks (compact snapshot the library subscribes to) ────────────────────

export interface DeckBrief {
    id: DeckId;
    loaded: boolean;
    playing: boolean;
    /** Current BPM = track BPM × tempo (0 when unknown), one decimal. */
    bpm: number;
    /** Loaded track id, null when the deck is empty. */
    trackId: string | null;
}

interface DeckLike {
    id: DeckId;
    loaded: boolean;
    playing: boolean;
    bpm: number;
    tempo: number;
    trackId: string | null;
}

const DECK_SEP = "\u0001";
const FIELD_SEP = "\u0002";

/**
 * One string for everything the library needs from the decks. It only changes when a deck
 * loads, starts / stops or changes tempo, so a store selector returning it does not re-render
 * the library on every engine snapshot.
 */
export function encodeDecks(decks: readonly DeckLike[]): string {
    return decks
        .map((d) => {
            const bpm = d.bpm > 0 ? d.bpm * (d.tempo > 0 ? d.tempo : 1) : 0;
            return [d.id, d.loaded ? 1 : 0, d.playing ? 1 : 0, bpm.toFixed(1), d.loaded ? (d.trackId ?? "") : ""].join(FIELD_SEP);
        })
        .join(DECK_SEP);
}

export function decodeDecks(key: string): DeckBrief[] {
    if (!key) return [];
    return key.split(DECK_SEP).map((part) => {
        const [id, loaded, playing, bpm, ...rest] = part.split(FIELD_SEP);
        const trackId = rest.join(FIELD_SEP);
        return { id: id as DeckId, loaded: loaded === "1", playing: playing === "1", bpm: Number(bpm) || 0, trackId: loaded === "1" && trackId ? trackId : null };
    });
}

/** Enter / double-click target: the deck that is not playing (A unless only A plays). */
export function freeDeck(decks: readonly { id: DeckId; playing: boolean }[]): DeckId {
    const a = decks.find((d) => d.id === "a");
    const b = decks.find((d) => d.id === "b");
    return a?.playing && !b?.playing ? "b" : "a";
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/**
 * Row height: 22 px in the dense (compact) density the Signature look ships with, 26 px
 * otherwise (targets ≥ 24 px), 28 px in booth mode, 44 px in touch mode.
 */
export function rowHeightFor(d: { density?: string | undefined; touch?: string | undefined; booth?: string | undefined }): number {
    if (d.touch === "on") return 44;
    if (d.booth === "on") return 28;
    return d.density === "compact" ? 22 : 26;
}

export type ColId = "status" | "preview" | "title" | "artist" | "bpm" | "key" | "energy" | "time" | "genre" | "added" | "rating" | "load";

export interface Columns {
    cols: readonly ColId[];
    /** `grid-template-columns` shared by the header and every row. */
    template: string;
    /** The BPM column also shows the ±% difference against the match deck. */
    diff: boolean;
}

export const COL_GAP = 8;
const FULL_ORDER: readonly ColId[] = ["status", "preview", "title", "artist", "bpm", "key", "energy", "time", "genre", "added", "rating", "load"];
/** Columns given up as the panel narrows, first to last. */
export const DROP_ORDER: readonly ColId[] = ["added", "genre", "energy", "preview", "rating"];
/** Room title + artist keep before a column is dropped. */
const TEXT_MIN = 200;
const BPM_W = 44;
const DIFF_W = 48;

function has(cols: readonly ColId[], id: ColId): boolean {
    return cols.includes(id);
}

function colWidth(id: ColId, o: { diff: boolean; btn: number }): number {
    switch (id) {
        case "status":
            return 30;
        case "preview":
            return 120;
        case "bpm":
            return o.diff ? BPM_W + DIFF_W : BPM_W;
        case "key":
            return 48;
        case "energy":
            return 52;
        case "time":
            return 40;
        case "genre":
            return 96;
        case "added":
            return 60;
        case "rating":
            return o.btn + 16;
        case "load":
            return o.btn * 3 + 4;
        default:
            return 0;
    }
}

function template(cols: readonly ColId[], o: { diff: boolean; btn: number }): string {
    return cols.map((c) => (c === "title" ? "minmax(0, 1.6fr)" : c === "artist" ? "minmax(0, 1fr)" : `${colWidth(c, o)}px`)).join(" ");
}

/**
 * Full-tier columns for a content width of `width` px (row padding already removed).
 * `diff` = a match deck is chosen; `btn` = row button width (24, or 44 in touch mode).
 */
export function fullColumns(width: number, o: { diff: boolean; btn: number }): Columns {
    let cols = FULL_ORDER;
    let diff = o.diff;
    const need = (c: readonly ColId[], d: boolean) =>
        c.reduce((sum, id) => sum + colWidth(id, { diff: d, btn: o.btn }), 0) + COL_GAP * (c.length - 1) + TEXT_MIN;
    for (const drop of DROP_ORDER) {
        if (need(cols, diff) <= width) break;
        cols = cols.filter((c) => c !== drop);
    }
    // Last resort before the text starves: the ±% text (the tooltip still carries it).
    if (diff && need(cols, diff) > width) diff = false;
    return { cols, template: template(cols, { diff, btn: o.btn }), diff };
}

/** Compact tier: status, one text column (title · artist), BPM, key, time when there is room, load A/B. */
export function compactColumns(width: number, o: { btn: number }): Columns {
    const cols: ColId[] = ["status", "title", "bpm", "key", ...(width >= 400 ? (["time"] as const) : []), "load"];
    const w = (c: ColId) => (c === "status" ? 18 : c === "load" ? o.btn * 2 + 2 : colWidth(c, { diff: false, btn: o.btn }));
    return { cols, template: cols.map((c) => (c === "title" ? "minmax(0, 1fr)" : `${w(c)}px`)).join(" "), diff: false };
}

/** Icon tier: status + title only (load buttons sit in the toolbar). */
export const ICON_COLUMNS: Columns = { cols: ["status", "title"], template: "18px minmax(0, 1fr)", diff: false };

export function hasCol(c: Columns, id: ColId): boolean {
    return has(c.cols, id);
}

// ─── Cells ──────────────────────────────────────────────────────────────────

/** Energy 1..10 as five cells: 1 = full, 0.5 = half, 0 = empty. */
export function energyCells(energy: number): number[] {
    const e = Math.min(10, Math.max(0, energy));
    return Array.from({ length: 5 }, (_, i) => {
        const v = e / 2 - i;
        return v >= 1 ? 1 : v >= 0.5 ? 0.5 : 0;
    });
}

/**
 * SVG path (`viewBox="0 0 <bins> <height>"`) of a mirrored overview waveform from peak bins
 * 0..255. Built once per track; scaling to the cell is left to `preserveAspectRatio="none"`.
 */
export function previewPath(bins: ArrayLike<number>, height = 32): string {
    const n = bins.length;
    if (n === 0) return "";
    const c = height / 2;
    const amp = (i: number) => Math.max(0.5, ((bins[i] ?? 0) / 255) * c);
    const r = (v: number) => Math.round(v * 10) / 10;
    let d = `M0 ${r(c - amp(0))}`;
    for (let i = 0; i < n; i++) d += `L${i + 0.5} ${r(c - amp(i))}`;
    d += `L${n} ${r(c - amp(n - 1))}L${n} ${r(c + amp(n - 1))}`;
    for (let i = n - 1; i >= 0; i--) d += `L${i + 0.5} ${r(c + amp(i))}`;
    return `${d}L0 ${r(c + amp(0))}Z`;
}

export function fmtDuration(sec: number | null | undefined): string {
    if (!sec || sec <= 0) return "";
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtBpm(bpm: number | null | undefined): string {
    return bpm && bpm > 0 ? bpm.toFixed(1) : "–";
}

/** "+5.3%", "−1.2%", "±0.0%" (real minus sign, one decimal). */
export function fmtDiff(pct: number): string {
    if (Math.abs(pct) < 0.05) return "±0.0%";
    return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

/** Plural category for the track count ("1 piesă", "5 piese", "20 de piese"). */
export function pluralCategory(n: number, locale: string): "one" | "few" | "other" {
    const c = new Intl.PluralRules(locale).select(n);
    return c === "one" ? "one" : c === "few" ? "few" : "other";
}

/** `added_at` of the companion ("2026-11-07 15:54:28", UTC) → Date, null when unparsable. */
export function parseAdded(addedAt: string | null | undefined): Date | null {
    if (!addedAt) return null;
    const iso = addedAt.includes("T") ? addedAt : `${addedAt.replace(" ", "T")}Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}
