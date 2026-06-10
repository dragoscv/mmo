/**
 * Harmonic-mixing helpers: Camelot-wheel compatibility + a transition score
 * that combines key compatibility with BPM proximity. Used by the mix-assist
 * panel to suggest the best next track against what's playing.
 *
 * Camelot notation: `<number 1-12><letter A|B>` where A = minor, B = major.
 * Compatible moves (the "rules"):
 *   - same key (perfect)
 *   - ±1 on the wheel, same letter (energy up/down)
 *   - same number, switch letter (relative major/minor)
 * We also allow a couple of softer pro moves with lower scores:
 *   - +7 same letter (dominant / "energy boost")
 *   - ±2 same letter (whole-step, more adventurous)
 */

export interface CamelotKey {
    /** 1..12 */
    number: number;
    /** "A" (minor) | "B" (major) */
    letter: "A" | "B";
}

const CAMELOT_RE = /^(\d{1,2})([AB])$/i;

/** Parse a Camelot label like "8A" / "12B". Returns null when invalid. */
export function parseCamelot(label: string | null | undefined): CamelotKey | null {
    if (!label) return null;
    const m = CAMELOT_RE.exec(label.trim());
    if (!m) return null;
    const number = Number(m[1]);
    if (number < 1 || number > 12) return null;
    return { number, letter: m[2]!.toUpperCase() as "A" | "B" };
}

/** Shortest distance around the 12-step wheel (0..6). */
function wheelDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % 12;
    return Math.min(d, 12 - d);
}

/** A qualitative label + 0..1 score for moving from `from` to `to`. */
export interface KeyCompatibility {
    score: number;
    label: string;
}

/**
 * Score a key transition 0..1 with a human-readable label. Higher = smoother.
 * Returns score 0 for clashing keys.
 */
export function keyCompatibility(from: CamelotKey | null, to: CamelotKey | null): KeyCompatibility {
    if (!from || !to) return { score: 0, label: "—" };

    // Perfect: identical key.
    if (from.number === to.number && from.letter === to.letter) {
        return { score: 1, label: "Perfect" };
    }

    // Relative major/minor: same number, opposite letter.
    if (from.number === to.number && from.letter !== to.letter) {
        return { score: 0.92, label: "Relative" };
    }

    const dist = wheelDistance(from.number, to.number);
    const sameLetter = from.letter === to.letter;

    if (sameLetter) {
        if (dist === 1) return { score: 0.85, label: "Adjacent" };
        // +7 semitones on the wheel of fifths shows up as a distance-of-5 hop.
        if (dist === 5) return { score: 0.6, label: "Energy boost" };
        if (dist === 2) return { score: 0.45, label: "Whole step" };
    } else {
        // Diagonal moves: ±1 number AND letter switch ("energy mixing").
        if (dist === 1) return { score: 0.55, label: "Diagonal" };
    }

    return { score: 0, label: "Clash" };
}

/** Convert a BPM difference into a 0..1 closeness score (1 = identical). */
export function bpmCloseness(fromBpm: number, toBpm: number): number {
    if (fromBpm <= 0 || toBpm <= 0) return 0;
    // Allow octave (½×/2×) matches: fold the ratio into [1, 2).
    let ratio = toBpm / fromBpm;
    while (ratio < 1) ratio *= 2;
    while (ratio >= 2) ratio /= 2;
    // Distance from a perfect 1.0 (or its 2.0 wrap), normalised by a ±6% window.
    const dist = Math.min(Math.abs(ratio - 1), Math.abs(ratio - 2));
    const pct = dist; // ~0..1
    return Math.max(0, 1 - pct / 0.06);
}

export interface TransitionScore {
    /** Combined 0..1 score (key-weighted). */
    score: number;
    key: KeyCompatibility;
    bpm: number;
    /** Pitch-bend % needed to beat-match (signed, relative to source BPM). */
    bpmAdjustPct: number;
}

/**
 * Combined transition score. Key compatibility dominates (70%), BPM closeness
 * fills the rest (30%) — a perfect key with a small tempo nudge still ranks well.
 */
export function transitionScore(
    from: { key: CamelotKey | null; bpm: number },
    to: { key: CamelotKey | null; bpm: number },
): TransitionScore {
    const key = keyCompatibility(from.key, to.key);
    const bpm = bpmCloseness(from.bpm, to.bpm);
    // If either key is unknown, fall back to a BPM-only score so the list still
    // ranks sensibly.
    const score = from.key && to.key ? key.score * 0.7 + bpm * 0.3 : bpm;

    let bpmAdjustPct = 0;
    if (from.bpm > 0 && to.bpm > 0) {
        // Smallest tempo change (allowing octave) to match the playing deck.
        let target = from.bpm;
        const candidates = [target, target * 2, target / 2];
        let best = candidates[0]!;
        let bestDiff = Math.abs(to.bpm - best);
        for (const c of candidates) {
            const d = Math.abs(to.bpm - c);
            if (d < bestDiff) {
                best = c;
                bestDiff = d;
            }
        }
        bpmAdjustPct = ((best - to.bpm) / to.bpm) * 100;
    }

    return { score, key, bpm, bpmAdjustPct };
}
