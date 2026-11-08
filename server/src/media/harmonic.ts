/**
 * Harmonic mixing (WP17-44, port of apps/mixai/src/lib/harmonic.ts so every client shares one scorer): Camelot-wheel
 * key compatibility + BPM proximity (±6 % window, half/double tempo allowed), a greedy harmonic queue order, and
 * musical-key → Camelot conversion for file tags. Pure.
 */

export interface CamelotKey { number: number; letter: "A" | "B" }

const CAMELOT_RE = /^(\d{1,2})([AB])$/i;

export function parseCamelot(label: string | null | undefined): CamelotKey | null {
    if (!label) return null;
    const m = CAMELOT_RE.exec(label.trim());
    if (!m) return null;
    const number = Number(m[1]);
    if (number < 1 || number > 12) return null;
    return { number, letter: m[2]!.toUpperCase() as "A" | "B" };
}

function wheelDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % 12;
    return Math.min(d, 12 - d);
}

/** 0..1: perfect 1, relative 0.92, adjacent 0.85, diagonal 0.55, energy boost 0.6, whole step 0.45, clash 0. */
export function keyScore(from: CamelotKey | null, to: CamelotKey | null): number {
    if (!from || !to) return 0;
    if (from.number === to.number) return from.letter === to.letter ? 1 : 0.92;
    const dist = wheelDistance(from.number, to.number);
    if (from.letter === to.letter) {
        if (dist === 1) return 0.85;
        if (dist === 5) return 0.6;
        if (dist === 2) return 0.45;
    } else if (dist === 1) return 0.55;
    return 0;
}

/** Tempo ratio folded into [1, 2) (half/double tempo match). */
function folded(fromBpm: number, toBpm: number): number {
    let r = toBpm / fromBpm;
    while (r < 1) r *= 2;
    while (r >= 2) r /= 2;
    return r;
}

/** 1 = same tempo, 0 = 6 % or more apart (after half/double folding). */
export function bpmCloseness(fromBpm: number | null | undefined, toBpm: number | null | undefined): number {
    if (!fromBpm || !toBpm || fromBpm <= 0 || toBpm <= 0) return 0;
    const r = folded(fromBpm, toBpm);
    const dist = Math.min(Math.abs(r - 1), Math.abs(r - 2));
    return Math.max(0, 1 - dist / 0.06);
}

export interface Harmonic { keyCamelot?: string | null; bpm?: number | null }

/** Key 70 % + BPM 30 %; BPM only when a key is unknown; 0 when nothing is known. */
export function transitionScore(from: Harmonic, to: Harmonic): number {
    const fk = parseCamelot(from.keyCamelot);
    const tk = parseCamelot(to.keyCamelot);
    const bpm = bpmCloseness(from.bpm, to.bpm);
    return fk && tk ? keyScore(fk, tk) * 0.7 + bpm * 0.3 : bpm;
}

/**
 * Greedy harmonic order: keeps `items[start]` first, then always the remaining item with the best transition from the
 * previous one (ties keep the original order). Items with neither key nor BPM keep their relative order at the end.
 */
export function harmonicOrder<T extends Harmonic>(items: readonly T[], start = 0): T[] {
    const first = Math.max(0, Math.min(items.length - 1, start));
    if (items.length <= 2) return items.length === 2 && first === 1 ? [items[1]!, items[0]!] : items.slice();
    const known = (t: T) => !!parseCamelot(t.keyCamelot) || (!!t.bpm && t.bpm > 0);
    const out: T[] = [items[first]!];
    const rest = items.filter((_, i) => i !== first);
    const pool = rest.filter(known);
    const tail = rest.filter((t) => !known(t));
    let cur = out[0]!;
    while (pool.length > 0) {
        let best = 0;
        let bestScore = -1;
        for (let i = 0; i < pool.length; i++) {
            const s = transitionScore(cur, pool[i]!);
            if (s > bestScore) { bestScore = s; best = i; }
        }
        cur = pool.splice(best, 1)[0]!;
        out.push(cur);
    }
    return out.concat(tail);
}

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** Camelot number for a major key by pitch class (C = 8B), minor = relative (A minor = 8A). */
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

/**
 * File-tag key → Camelot: "8A", "Am", "A minor", "F#m", "Gbmaj", "C", Open Key "1m"/"1d"; null when unreadable.
 * Open Key: nd = major (1d = C = 8B), nm = minor (1m = Am = 8A); camelot = ((open + 6) % 12) + 1.
 */
export function toCamelot(raw: string | null | undefined): string | null {
    const s = (raw ?? "").trim();
    if (!s) return null;
    const cam = parseCamelot(s);
    if (cam) return `${cam.number}${cam.letter}`;
    const open = /^(\d{1,2})\s*([dm])$/i.exec(s);
    if (open) {
        const n = Number(open[1]);
        if (n < 1 || n > 12) return null;
        return `${((n + 6) % 12) + 1}${open[2]!.toLowerCase() === "d" ? "B" : "A"}`;
    }
    const m = /^([a-g])\s*(#|♯|b|♭)?\s*(m|min|minor|maj|major|dur|moll)?$/i.exec(s.replace(/\s+/g, " "));
    if (!m) return null;
    let pc = PITCH[m[1]!.toLowerCase()]!;
    const acc = m[2];
    if (acc === "#" || acc === "♯") pc += 1;
    if (acc === "b" || acc === "♭") pc -= 1;
    pc = ((pc % 12) + 12) % 12;
    const q = (m[3] ?? "").toLowerCase();
    const minor = q === "m" || q === "min" || q === "minor" || q === "moll";
    // Minor key = relative major's Camelot number (A minor ↔ C major).
    const majorPc = minor ? (pc + 3) % 12 : pc;
    return `${MAJOR_CAMELOT[majorPc]}${minor ? "A" : "B"}`;
}
