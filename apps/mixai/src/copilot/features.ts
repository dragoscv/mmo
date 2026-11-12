/**
 * Pure helpers of the co-pilot: which deck is the reference, what the engine and the library
 * know about a track in the shape the Rust side wants (`TrackFeat`), and the candidate list.
 * No DOM, no store (tested with `node --test features.test.ts`).
 */
import type { Candidate, PlanInfo, TrackFeat } from "../bridge/copilot.ts";
import type { DeckId, DeckState, LibraryTrack } from "../bridge/types.ts";

const MAIN: readonly DeckId[] = ["a", "b", "c", "d"];

/** Only what the co-pilot reads from a deck (a `DeckState` fits). */
export type DeckLike = Pick<DeckState, "id" | "trackId" | "title" | "artist" | "loaded" | "playing" | "position" | "duration" | "bpm" | "tempo" | "firstBeat" | "hasStems">;

function finite(v: number | null | undefined): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function buildFeat(t: LibraryTrack): TrackFeat {
    const bpm = finite(t.bpm);
    const energy = finite(t.energy);
    return {
        id: String(t.id),
        title: (t.title ?? "").trim() || t.filename,
        artist: (t.artist ?? "").trim(),
        bpm: bpm !== null && bpm > 0 ? bpm : null,
        key: t.keyCamelot?.trim() || null,
        energy: energy !== null && energy >= 1 && energy <= 10 ? energy : null,
        durationSec: Math.max(0, finite(t.duration) ?? 0),
        firstBeatSec: 0,
        downbeatOffset: 0,
        lufs: null,
        hasStems: t.stemsStatus === "ready",
    };
}

/** Features per row object: the pool keeps its rows while it grows page by page and between rankings. */
const featCache = new WeakMap<LibraryTrack, TrackFeat>();

/**
 * Features of a library row. `energy` may be absent on older companions: sent as null. The
 * answer is cached per row object and must not be changed by the caller.
 */
export function trackFeat(t: LibraryTrack): TrackFeat {
    let feat = featCache.get(t);
    if (!feat) {
        feat = buildFeat(t);
        featCache.set(t, feat);
    }
    return feat;
}

/**
 * Features of the track on a deck: tempo, first beat and length from the engine (it analysed
 * the file), key from the deck's key, energy from the library row of the same track when the
 * pool has it.
 */
export function deckFeat(d: DeckLike, key: string | null, row: LibraryTrack | null): TrackFeat {
    const fromRow = row ? trackFeat(row) : null;
    const bpm = finite(d.bpm);
    const duration = finite(d.duration);
    return {
        id: d.trackId ?? `deck-${d.id}`,
        title: (d.title ?? "").trim() || fromRow?.title || "",
        artist: (d.artist ?? "").trim() || fromRow?.artist || "",
        bpm: bpm !== null && bpm > 0 ? bpm : (fromRow?.bpm ?? null),
        key: key?.trim() || fromRow?.key || null,
        energy: fromRow?.energy ?? null,
        durationSec: duration !== null && duration > 0 ? duration : (fromRow?.durationSec ?? 0),
        firstBeatSec: Math.max(0, finite(d.firstBeat) ?? 0),
        downbeatOffset: 0,
        lufs: null,
        hasStems: d.hasStems || (fromRow?.hasStems ?? false),
    };
}

/** The library row loaded on a deck (by track id), or null. */
export function rowOf(pool: readonly LibraryTrack[], trackId: string | null): LibraryTrack | null {
    if (!trackId) return null;
    return pool.find((t) => String(t.id) === trackId) ?? null;
}

/**
 * The deck that carries the mix: the master clock's deck when it plays, else the first playing
 * deck (A, B, C, D). Null when nothing plays.
 */
export function playingDeck(decks: readonly Pick<DeckState, "id" | "loaded" | "playing">[], clockSource: string | null | undefined): DeckId | null {
    const playing = MAIN.filter((id) => decks.some((d) => d.id === id && d.loaded && d.playing));
    if (playing.length === 0) return null;
    return playing.find((id) => id === clockSource) ?? playing[0]!;
}

/** The deck suggestions are ranked against: the playing deck, else the first loaded one. */
export function referenceDeck(decks: readonly Pick<DeckState, "id" | "loaded" | "playing">[], clockSource: string | null | undefined): DeckId | null {
    return playingDeck(decks, clockSource) ?? MAIN.find((id) => decks.some((d) => d.id === id && d.loaded)) ?? null;
}

/** Where the next track goes: A ↔ B; from C or D the main deck that is not playing (A first). */
export function otherDeck(from: DeckId, decks: readonly Pick<DeckState, "id" | "playing">[]): DeckId {
    if (from === "a") return "b";
    if (from === "b") return "a";
    return decks.some((d) => d.id === "a" && d.playing) ? "b" : "a";
}

/** Candidates for the ranking: every pool track with the minutes since it last played. */
export function candidates(pool: readonly LibraryTrack[], played: Readonly<Record<string, number>>, now: number): Candidate[] {
    return pool.map((t) => {
        const at = played[String(t.id)];
        const minutes = typeof at === "number" && now >= at ? (now - at) / 60_000 : null;
        return { track: trackFeat(t), playedMinutesAgo: minutes };
    });
}

/** Bars (to half a bar) from the playhead to the planned start; 0 once it is reached. */
export function barsUntil(plan: Pick<PlanInfo, "startSec">, positionSec: number, bpm: number, beatsPerBar = 4): number {
    if (!(bpm > 0) || !Number.isFinite(positionSec)) return 0;
    const bars = ((plan.startSec - positionSec) * bpm) / 60 / beatsPerBar;
    return Math.max(0, Math.round(bars * 2) / 2);
}

/**
 * Suggestion rows in the popover (px), in step with copilot.css: a row is as high as its Load
 * buttons (`--cp-min`: 24 px, 44 px in touch mode) plus, when the reasons are shown, one 12 px
 * line of text.
 */
export const CONTROL_MIN = 24;
export const CONTROL_MIN_TOUCH = 44;
export const ROW_WHY_H = 12;
export const ROW_H = CONTROL_MIN + ROW_WHY_H;
export const ROW_H_DENSE = CONTROL_MIN;
export const ROW_GAP = 2;

/** Height of one row for a control size (`min` = `--cp-min` in px). */
export function rowHeight(dense: boolean, min: number = CONTROL_MIN): number {
    const control = Number.isFinite(min) && min > 0 ? min : CONTROL_MIN;
    return dense ? control : control + ROW_WHY_H;
}

function rowsHeight(n: number, dense: boolean, min: number): number {
    return n <= 0 ? 0 : n * rowHeight(dense, min) + (n - 1) * ROW_GAP;
}

/**
 * How the suggestion list fits the popover without scrolling: `avail` = height the popover may
 * take, `fixed` = height of everything but the list, `count` = suggestions on hand, `min` = the
 * control size the rows are built from (24 px, 44 px in touch mode: the same `--cp-min` the
 * stylesheet sizes the rows and their Load buttons with). Two-line rows when all fit, else
 * one-line rows (reasons move to the tooltip), else fewer rows (at least one).
 */
export function fitRows(avail: number, fixed: number, count: number, min: number = CONTROL_MIN): { rows: number; dense: boolean } {
    if (count <= 0) return { rows: 0, dense: false };
    const room = avail - fixed;
    if (rowsHeight(count, false, min) <= room) return { rows: count, dense: false };
    for (let n = count; n > 1; n--) if (rowsHeight(n, true, min) <= room) return { rows: n, dense: true };
    return { rows: 1, dense: true };
}

/** "44px" / " 24px " (a computed custom property) → px; anything else → the 24 px default. */
export function controlMin(css: string | null | undefined): number {
    const v = Number.parseFloat((css ?? "").trim());
    return Number.isFinite(v) && v >= CONTROL_MIN ? v : CONTROL_MIN;
}

/**
 * Arrow keys in the suggestion list: Up / Down move between rows in the same column, Left /
 * Right between Load A and Load B of the row, Home / End to the first / last row. The position
 * stops at the edges (no wrap). Null = not a key of the list.
 */
export function listMove(key: string, row: number, col: number, rows: number, cols = 2): { row: number; col: number } | null {
    if (rows <= 0 || cols <= 0) return null;
    const r = Math.min(Math.max(row, 0), rows - 1);
    const c = Math.min(Math.max(col, 0), cols - 1);
    switch (key) {
        case "ArrowUp":
            return { row: Math.max(0, r - 1), col: c };
        case "ArrowDown":
            return { row: Math.min(rows - 1, r + 1), col: c };
        case "ArrowLeft":
            return { row: r, col: Math.max(0, c - 1) };
        case "ArrowRight":
            return { row: r, col: Math.min(cols - 1, c + 1) };
        case "Home":
            return { row: 0, col: c };
        case "End":
            return { row: rows - 1, col: c };
        default:
            return null;
    }
}

/** The four arrow keys: global shortcuts of the app (crossfader hard left / right, centre). */
export function isArrowKey(key: string): boolean {
    return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}

/**
 * Reason tags of a suggestion in the order they are shown: the ones that say something first,
 * the "unknown" ones (`key_unknown`, `energy_unknown`) last. The reason line of a row is one
 * truncated line: on tracks without key and energy the two "unknown" reasons otherwise fill it
 * and the reason that tells the rows apart (tempo) is cut. The order within each group is kept.
 */
export function orderReasons(reasons: readonly string[]): string[] {
    const unknown = (r: string) => r.endsWith("_unknown");
    return [...reasons.filter((r) => !unknown(r)), ...reasons.filter(unknown)];
}

/**
 * Must an arrow key pressed inside the popover be kept from the app's global shortcuts? Bare
 * (and Shift) arrows are "crossfader hard to A / B" and "centre" there; only keys typed in an
 * editable field are skipped by the global listener, so an arrow on a button of the popover
 * would move the crossfader on air. True = call `preventDefault` (the global listener ignores
 * a prevented key). Ctrl / Cmd / Alt combinations are not shortcuts and pass.
 */
export function keepArrowFromShortcuts(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
    if (!isArrowKey(e.key)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    // A text field moves its caret with the arrows; the global listener skips it by itself.
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true) return false;
    return true;
}

/** Catalogue keys of the messages the shell can answer a co-pilot command with. */
export type CopilotErrorKey =
    | "copilot.err.notPlaying"
    | "copilot.err.noTrack"
    | "copilot.err.noGrid"
    | "copilot.err.stale"
    | "copilot.err.crossfader"
    | "copilot.err.running"
    | "copilot.err.noEngine"
    | "copilot.err.noRunner"
    | "copilot.err.failed";

/** The shell answers in English; map what it says to a catalogue key (the raw text stays as a tooltip). */
export function errorKey(message: string): CopilotErrorKey {
    if (/transition thread/i.test(message)) return "copilot.err.noRunner";
    if (/is not playing/i.test(message)) return "copilot.err.notPlaying";
    if (/has no track|is missing/i.test(message)) return "copilot.err.noTrack";
    if (/no tempo|beatgrid/i.test(message)) return "copilot.err.noGrid";
    if (/plan again/i.test(message)) return "copilot.err.stale";
    if (/crossfader cuts/i.test(message)) return "copilot.err.crossfader";
    if (/already running/i.test(message)) return "copilot.err.running";
    if (/engine (is )?not running|audio engine/i.test(message)) return "copilot.err.noEngine";
    return "copilot.err.failed";
}

/** Deck letter of a run the shell stopped because that deck got another track; null = another reason. */
export function trackChangedDeck(errors: readonly string[]): string | null {
    for (const e of errors) {
        const m = /deck ([a-d]) got another track/i.exec(e);
        if (m) return m[1]!.toUpperCase();
    }
    return null;
}

/**
 * Deck a typed transport command acts on when it names none: "play" starts the loaded main
 * deck that is not playing (the next track), everything else acts on the reference deck.
 */
export function intentDeck(action: string, named: DeckId | null, decks: readonly Pick<DeckState, "id" | "loaded" | "playing">[], clockSource: string | null | undefined): DeckId | null {
    if (named) return named;
    const ref = referenceDeck(decks, clockSource);
    if (action !== "play") return ref;
    const idle = (["a", "b"] as const).find((id) => decks.some((d) => d.id === id && d.loaded && !d.playing));
    return idle ?? ref;
}

/** Tempo step the co-pilot looks at: a pitch ride of 2 BPM is 4 steps, not 20. */
export const BPM_STEP = 0.5;

/** `bpm` on the [`BPM_STEP`] grid (0 for an unknown tempo). */
export function quantBpm(bpm: number): number {
    return Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm / BPM_STEP) * BPM_STEP : 0;
}

/**
 * One string for what the co-pilot needs from the decks: it changes when a deck loads, starts,
 * stops or changes tempo by half a BPM, not on every engine snapshot and not on every 0.1 BPM
 * of a pitch ride (so a subscriber is free while idle, while playing and while riding the pitch).
 */
export function decksKey(decks: readonly Pick<DeckState, "id" | "loaded" | "playing" | "trackId" | "bpm" | "tempo">[], clockSource: string | null | undefined, keys: Readonly<Record<DeckId, string | null>>): string {
    const parts = decks.map((d) => [d.id, d.loaded ? 1 : 0, d.playing ? 1 : 0, d.loaded ? (d.trackId ?? "") : "", d.bpm > 0 ? quantBpm(d.bpm * (d.tempo > 0 ? d.tempo : 1)).toFixed(1) : "0", keys[d.id] ?? ""].join("\u0002"));
    return `${clockSource ?? ""}\u0001${parts.join("\u0001")}`;
}

/**
 * Everything a ranking depends on, as one string: the playing track's features (tempo on the
 * half-BPM grid), the energy direction, and which candidates (`poolVersion` counts the pool and
 * request changes) with which play history (`historyVersion`). The store ranks again only when
 * this changes: the same question is not sent to the shell twice.
 */
export function rankKey(playing: TrackFeat, energy: string, poolVersion: number, historyVersion: number, limit: number): string {
    return [poolVersion, historyVersion, energy, limit, playing.id, playing.artist, playing.bpm === null ? "" : quantBpm(playing.bpm), playing.key ?? "", playing.energy ?? ""].join("\u0001");
}
