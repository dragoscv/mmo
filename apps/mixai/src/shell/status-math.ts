/**
 * Pure helpers of the status bar and the title bar (unit-tested: status-math.test.ts).
 * Everything here quantises a noisy engine value BEFORE it reaches React, so a steady app
 * renders nothing: the meter in cells, the audio load in whole percent with a dead band.
 */

/** Cells of the master level meter. */
export const VU_CELLS = 16;
/** Bottom of the meter scale in dBFS. One cell = -VU_FLOOR_DB / VU_CELLS = 3 dB. */
export const VU_FLOOR_DB = -48;

/**
 * Lit cells (0..cells) for a linear peak level 0..1, on a dB scale: cell k is lit when the
 * level is above `VU_FLOOR_DB + (k - 1) * step` dB, so the top cell means "above -3 dBFS".
 */
export function vuCells(level: number, cells: number = VU_CELLS): number {
    if (!(level > 0)) return 0;
    const db = 20 * Math.log10(Math.min(1, level));
    if (db <= VU_FLOOR_DB) return 0;
    return Math.max(1, Math.min(cells, Math.ceil(((db - VU_FLOOR_DB) / -VU_FLOOR_DB) * cells)));
}

/** Upper edge of the highest lit cell in dBFS (null = silence). */
export function vuCellsDb(lit: number, cells: number = VU_CELLS): number | null {
    if (lit <= 0) return null;
    return Math.round(VU_FLOOR_DB + (Math.min(lit, cells) * -VU_FLOOR_DB) / cells);
}

export type LoadLevel = "ok" | "warn" | "alert";
export const LOAD_WARN = 70;
export const LOAD_ALERT = 100;
export const LOAD_CELLS = 5;

/** Engine load (callback time / buffer period, 1 = the whole period) as whole percent. */
export function loadPct(load: number | undefined): number {
    if (load === undefined || !(load > 0)) return 0;
    return Math.min(999, Math.round(load * 100));
}

export function loadLevel(pct: number): LoadLevel {
    return pct >= LOAD_ALERT ? "alert" : pct >= LOAD_WARN ? "warn" : "ok";
}

/** Lit cells of the load bar: one cell per started 20 %, full from 100 %. */
export function loadCells(pct: number, cells: number = LOAD_CELLS): number {
    if (!(pct > 0)) return 0;
    return Math.min(cells, Math.ceil((pct / 100) * cells));
}

/**
 * The value to show: keep `shown` unless the new one moved by 2 points or more, crossed a
 * level (ok / warn / alert) or dropped to zero. Stops idle jitter from re-rendering the bar.
 */
export function steadyPct(shown: number, next: number): number {
    if (next === shown) return shown;
    if (next === 0 || loadLevel(next) !== loadLevel(shown)) return next;
    return Math.abs(next - shown) >= 2 ? next : shown;
}

/**
 * Most frequent value of a sampling window (`counts`: value -> times seen). A tie keeps
 * `shown` when it is one of the winners; an empty window keeps `shown` too.
 */
export function modeOf(counts: ReadonlyMap<number, number>, shown: number): number {
    let best = shown;
    let bestN = 0;
    for (const [v, n] of counts) {
        if (n > bestN || (n === bestN && v === shown)) {
            best = v;
            bestN = n;
        }
    }
    return best;
}

/** Buffer size in frames from the buffer latency. */
export function bufferFrames(latencyMs: number, sampleRate: number): number {
    return Math.round((latencyMs * sampleRate) / 1000);
}

const two = (n: number) => String(n).padStart(2, "0");

/** Local time as HH:MM (24 h). */
export function clockText(d: Date): string {
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Milliseconds until the minute changes (at least 50 ms, so a timer never spins). */
export function msToNextMinute(d: Date): number {
    return Math.max(50, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()));
}

/** Recording time as MM:SS (minutes keep counting past 59). */
export function recTime(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** Overrun counter text: capped so the item keeps its width. */
export function overrunText(n: number): string {
    return n > 9999 ? "9999+" : String(Math.max(0, Math.floor(n)));
}

/** Endpoint words that say nothing about WHICH device it is (the adapter name does). */
const GENERIC_ENDPOINT =
    /^(speakers?|headphones?|headset|earphones?|line( out)?|output|digital (audio|output).*|s\/?pdif.*|difuzoare|boxe|căști|casti|lautsprecher|kopfhörer|haut-parleurs?|casque|altavoces|auriculares|altoparlanti|cuffie)$/i;

/**
 * Short name of an output device. Windows names are "Endpoint (Adapter)": keep the endpoint,
 * unless it is a generic word ("Speakers (DDJ-FLX4)" -> "DDJ-FLX4").
 */
export function shortDevice(name: string): string {
    const full = name.trim();
    const m = /^(.*?)\s*\((.+)\)$/.exec(full);
    if (!m) return full;
    const endpoint = m[1]!.trim();
    const adapter = m[2]!.trim();
    if (!endpoint) return adapter;
    return GENERIC_ENDPOINT.test(endpoint) ? adapter : endpoint;
}
