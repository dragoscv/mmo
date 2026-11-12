/**
 * Practice mode scoring (pure, no store, no engine; unit-tested in scoring.test.ts).
 *
 * The store feeds one {@link PracticeSample} about four times a second while practice is on.
 * A session accumulates four criteria, each 0..1:
 *
 *   tempo   how close the two decks in the mix run: |bpmB / bpmA - 1| (half / double time
 *           counts as the same tempo), 1 at up to 0.2 %, 0 from 3 %.
 *   phase   how well their beats line up: |beat phase difference|, 1 at up to 0.03 beat,
 *           0 from a quarter of a beat. In half / double time the beats of the faster deck
 *           are compared with the half beats of the slower one (the same fold as the tempo).
 *   key     Camelot compatibility of the two track keys (lib/harmonic `keyCompatibility`).
 *   level   steps of the master level the DJ made: the loudest moment of the last second
 *           against the loudest of the second before; more than 6 dB apart = one jump, but
 *           only when a control that sets the level (channel fader, trim, crossfader, master
 *           volume, starting or stopping a deck) moved in the seconds before. A break into a
 *           drop in the music itself is not a jump, nor is an EQ or filter move (a sweep
 *           into a drop is a technique, not a mistake). Starting from silence and stopping
 *           are not jumps.
 *
 * Tempo, phase and key only count while TWO decks are in the mix (playing and audible): the
 * deck being prepared in the headphones is not judged. The session score is the weighted mean
 * of the criteria that have data, times 100, plus a small bonus for every smooth blend
 * (crossfader taken from one side to the other at a pace of 8 s or slower for the whole travel,
 * with the decks in time on the way).
 *
 * All of it is a heuristic over a few engine readings four times a second: a guide for
 * practice, not a judge of a mix.
 */
import { keyCompatibility, parseCamelot } from "../lib/harmonic.ts";

export type Criterion = "tempo" | "phase" | "key" | "level";
export const CRITERIA: readonly Criterion[] = ["tempo", "phase", "key", "level"];

export type TipId = "tempo_drift" | "phase_off" | "key_clash" | "level_jump" | "good_blend";

export interface PracticeSample {
    /** Seconds on any monotonic clock. */
    t: number;
    /** Audible tempo of the two decks in the mix; null = fewer than two decks are in the mix. */
    bpmA: number | null;
    bpmB: number | null;
    /**
     * Beat phase of deck B against deck A, in beats of the FASTER deck (-0.5..0.5; in half /
     * double time the slower deck's half beats count, see {@link foldedPhaseError}); null =
     * unknown.
     */
    phaseErrBeats: number | null;
    /** Camelot keys of the two tracks ("8A"); null = unknown. */
    keyA: string | null;
    keyB: string | null;
    /** Master level in dBFS; null = silence. */
    masterDb: number | null;
    /** Crossfader, -1 (A side) .. 1 (B side). */
    crossfader: number;
    /**
     * Every control that sets the master level, each scaled to about one unit of full travel
     * ({@link levelControls}). A level step counts as a jump only when one of them moved.
     */
    controls: readonly number[];
}

/** Tempo difference (fraction) that still scores 1, and the one that scores 0. */
export const TEMPO_OK = 0.002;
export const TEMPO_BAD = 0.03;
/** Beat phase difference (beats) that still scores 1, and the one that scores 0. */
export const PHASE_OK = 0.03;
export const PHASE_BAD = 0.25;
/** A master level step larger than this (dB) from one second to the next is a jump. */
export const LEVEL_JUMP_DB = 6;
export const LEVEL_WINDOW_SEC = 1;
/** Levels under this (dBFS) count as silence. */
export const LEVEL_FLOOR_DB = -40;
/** A control that moved by more than this (of its full travel) since its last rest moved. */
export const CONTROL_EPS = 0.01;
/**
 * How long before a level step a control movement explains it: a step down shows only after
 * the louder second has left the "last second" window, up to two windows after the move.
 */
export const CONTROL_WINDOW_SEC = 2.5;
/** Jumps per minute of music at which the level criterion reaches 0. */
export const JUMPS_PER_MIN_ZERO = 5;
/**
 * A blend: the crossfader goes from one end zone (beyond -BLEND_ZONE) to the other (beyond
 * +BLEND_ZONE). The time between the two zones is measured, which is BLEND_ZONE of the whole
 * travel, so it must be at least BLEND_MIN_SEC * BLEND_ZONE: an even 8 s fade end to end.
 */
export const BLEND_ZONE = 0.9;
export const BLEND_MIN_SEC = 8;
/** "In time" during a blend: this share of its samples within the two limits below. */
export const BLEND_IN_TIME = 0.8;
export const IN_TIME_DRIFT = 0.01;
export const IN_TIME_PHASE = 0.1;
export const BLEND_BONUS = 5;
export const BLEND_BONUS_MAX = 10;
/** Longest time one sample may stand for (a hidden window delivers none for a while). */
export const MAX_DT = 1;
export const WEIGHTS: Readonly<Record<Criterion, number>> = { tempo: 0.3, phase: 0.3, key: 0.2, level: 0.2 };
/** A criterion under its value here gets a tip. */
export const TIP_BELOW: Readonly<Record<Criterion, number>> = { tempo: 0.75, phase: 0.75, key: 0.5, level: 0.8 };
export const MAX_TIPS = 3;

const TIP_OF: Readonly<Record<Criterion, TipId>> = { tempo: "tempo_drift", phase: "phase_off", key: "key_clash", level: "level_jump" };

interface LevelPoint {
    t: number;
    /** null = silence. */
    db: number | null;
}

interface BlendRun {
    /** Side the crossfader left: -1 = A, 1 = B. */
    from: -1 | 1;
    /** Time of the last sample on that side. */
    leftAt: number;
    samples: number;
    inTime: number;
}

export interface PracticeSession {
    lastT: number | null;
    /** Seconds with two decks in the mix, and the tempo score summed over them. */
    mixSec: number;
    tempoSum: number;
    phaseSec: number;
    phaseSum: number;
    keySec: number;
    keySum: number;
    /** Seconds with an audible master. */
    levelSec: number;
    jumps: number;
    lastJumpT: number | null;
    /** Master level of the last two windows. */
    levels: readonly LevelPoint[];
    /** The level controls at their last rest, and when one of them last moved. */
    controlRef: readonly number[] | null;
    lastMoveT: number | null;
    blends: number;
    blend: BlendRun | null;
}

export function newSession(): PracticeSession {
    return { lastT: null, mixSec: 0, tempoSum: 0, phaseSec: 0, phaseSum: 0, keySec: 0, keySum: 0, levelSec: 0, jumps: 0, lastJumpT: null, levels: [], controlRef: null, lastMoveT: null, blends: 0, blend: null };
}

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** 1 at `ok` and under, 0 at `bad` and over, a straight line between. */
function falling(v: number, ok: number, bad: number): number {
    return clamp01((bad - v) / (bad - ok));
}

const validBpm = (b: number | null): b is number => b !== null && Number.isFinite(b) && b > 0;

/**
 * How deck B's tempo folds onto deck A's: `factor` = the power of two (… 0.5, 1, 2 …) deck B
 * runs at against deck A (2 = double time), `ratio` = what is left of bpmB / bpmA after
 * taking that factor out (0.75..1.5; 1 = the same tempo).
 */
export function tempoFold(bpmA: number, bpmB: number): { factor: number; ratio: number } {
    let r = bpmB / bpmA;
    let factor = 1;
    if (!Number.isFinite(r) || r <= 0) return { factor: 1, ratio: Number.NaN };
    while (r > 1.5) {
        r /= 2;
        factor *= 2;
    }
    while (r < 0.75) {
        r *= 2;
        factor /= 2;
    }
    return { factor, ratio: r };
}

/** Tempo difference as a fraction of deck A's tempo; half and double time fold to "the same". */
export function tempoDrift(bpmA: number, bpmB: number): number {
    return Math.abs(tempoFold(bpmA, bpmB).ratio - 1);
}

export function tempoScore(drift: number): number {
    return falling(drift, TEMPO_OK, TEMPO_BAD);
}

export function phaseScore(errBeats: number): number {
    return falling(Math.abs(errBeats), PHASE_OK, PHASE_BAD);
}

/** Camelot compatibility 0..1; null when a key is unknown. */
export function keyScore(keyA: string | null, keyB: string | null): number | null {
    const a = parseCamelot(keyA);
    const b = parseCamelot(keyB);
    return a && b ? keyCompatibility(a, b).score : null;
}

/** Signed distance of `beat` from `ref` inside one beat: -0.5 (early) .. 0.5 (late). */
export function beatPhaseError(beat: number, ref: number): number {
    const d = (beat - ref) % 1;
    const r = d < -0.5 ? d + 1 : d >= 0.5 ? d - 1 : d;
    return r === 0 ? 0 : r;
}

/**
 * Beat phase of deck B against deck A when deck B runs `factor` times as fast (a power of
 * two from {@link tempoFold}; 1 = the same tempo). The faster deck's beat is compared with
 * `factor` times the slower deck's beat: at 87 against 174 BPM every beat of the slow deck
 * and every half beat between them must land on a beat of the fast deck. In beats of the
 * faster deck, -0.5..0.5; the sign is deck B early (-) or late (+).
 */
export function foldedPhaseError(beatA: number, beatB: number, factor: number): number {
    if (!(factor > 0) || !Number.isFinite(factor) || factor === 1) return beatPhaseError(beatB, beatA);
    if (factor > 1) return beatPhaseError(beatB, beatA * factor);
    // Deck A is the fast one: its error against B, seen from B.
    const e = -beatPhaseError(beatA, beatB / factor);
    return e === 0 ? 0 : e >= 0.5 ? e - 1 : e;
}

function loudest(points: readonly LevelPoint[]): number | null {
    let max: number | null = null;
    for (const p of points) if (p.db !== null && (max === null || p.db > max)) max = p.db;
    return max;
}

function crossfaderSide(x: number): -1 | 0 | 1 {
    return x <= -BLEND_ZONE ? -1 : x >= BLEND_ZONE ? 1 : 0;
}

/** A control moved: a different set of controls, or one of them further than {@link CONTROL_EPS}. */
function controlsMoved(ref: readonly number[], now: readonly number[]): boolean {
    if (ref.length !== now.length) return true;
    for (let i = 0; i < now.length; i++) {
        const a = ref[i]!;
        const b = now[i]!;
        // NaN on both sides is "the same unknown"; a number against NaN is a change.
        if (Number.isNaN(a) && Number.isNaN(b)) continue;
        if (!(Math.abs(a - b) <= CONTROL_EPS)) return true;
    }
    return false;
}

/** The session after one more sample (the input session is not changed). */
export function addSample(s: PracticeSession, x: PracticeSample): PracticeSession {
    if (!Number.isFinite(x.t)) return s;
    const gap = s.lastT === null ? 0 : x.t - s.lastT;
    // A long gap or a clock that went back: what came before says nothing about now.
    const broken = gap < 0 || gap > 2 * MAX_DT;
    const dt = broken ? 0 : Math.min(gap, MAX_DT);
    const n: PracticeSession = { ...s, lastT: x.t };

    const mixing = validBpm(x.bpmA) && validBpm(x.bpmB);
    const phase = x.phaseErrBeats !== null && Number.isFinite(x.phaseErrBeats) ? x.phaseErrBeats : null;
    let inTime = false;
    if (mixing) {
        const drift = tempoDrift(x.bpmA as number, x.bpmB as number);
        n.mixSec += dt;
        n.tempoSum += tempoScore(drift) * dt;
        if (phase !== null) {
            n.phaseSec += dt;
            n.phaseSum += phaseScore(phase) * dt;
            inTime = drift <= IN_TIME_DRIFT && Math.abs(phase) <= IN_TIME_PHASE;
        }
        const key = keyScore(x.keyA, x.keyB);
        if (key !== null) {
            n.keySec += dt;
            n.keySum += key * dt;
        }
    }

    // Master level: loudest of the last second against the loudest of the second before.
    const db = x.masterDb !== null && Number.isFinite(x.masterDb) && x.masterDb >= LEVEL_FLOOR_DB ? x.masterDb : null;
    const kept = broken ? [] : s.levels.filter((p) => p.t > x.t - 2 * LEVEL_WINDOW_SEC);
    const levels = [...kept, { t: x.t, db }];
    n.levels = levels;
    if (db !== null) n.levelSec += dt;
    const now = loudest(levels.filter((p) => p.t > x.t - LEVEL_WINDOW_SEC));
    const before = loudest(levels.filter((p) => p.t <= x.t - LEVEL_WINDOW_SEC));
    const rested = s.lastJumpT === null || x.t - s.lastJumpT >= 2 * LEVEL_WINDOW_SEC;
    // Which controls moved: against their last REST position, so a slow ride that adds up is
    // seen, and a move is remembered for as long as it can explain a level step.
    const controls = Array.isArray(x.controls) ? x.controls : [];
    if (broken || s.controlRef === null) {
        n.controlRef = controls;
        n.lastMoveT = null;
    } else if (controlsMoved(s.controlRef, controls)) {
        n.controlRef = controls;
        n.lastMoveT = x.t;
    }
    const moved = n.lastMoveT !== null && x.t - n.lastMoveT <= CONTROL_WINDOW_SEC;
    // The music itself (a break into a drop) steps the level too: only the DJ's steps count.
    if (now !== null && before !== null && Math.abs(now - before) > LEVEL_JUMP_DB && rested && moved) {
        n.jumps += 1;
        n.lastJumpT = x.t;
    }

    // Blend: the crossfader leaves one side and arrives on the other.
    const side = Number.isFinite(x.crossfader) ? crossfaderSide(x.crossfader) : 0;
    const run = broken ? null : s.blend;
    if (side !== 0) {
        if (run && side !== run.from) {
            const smooth = x.t - run.leftAt >= BLEND_MIN_SEC * BLEND_ZONE && run.samples > 0 && run.inTime / run.samples >= BLEND_IN_TIME;
            if (smooth) n.blends += 1;
        }
        n.blend = { from: side, leftAt: x.t, samples: 0, inTime: 0 };
    } else if (run) {
        n.blend = { ...run, samples: run.samples + 1, inTime: run.inTime + (inTime ? 1 : 0) };
    } else {
        n.blend = null;
    }
    return n;
}

export interface PracticeSummary {
    /** 0..100; null until two decks were in the mix. */
    score: number | null;
    /** 0..1 per criterion; null = no data yet. */
    sub: Record<Criterion, number | null>;
    /** Up to {@link MAX_TIPS}: the weakest criteria first, then the praise. */
    tips: TipId[];
    mixSec: number;
    blends: number;
    jumps: number;
}

export function summarize(s: PracticeSession): PracticeSummary {
    const sub: Record<Criterion, number | null> = {
        tempo: s.mixSec > 0 ? s.tempoSum / s.mixSec : null,
        phase: s.phaseSec > 0 ? s.phaseSum / s.phaseSec : null,
        key: s.keySec > 0 ? s.keySum / s.keySec : null,
        level: s.levelSec > 0 ? clamp01(1 - s.jumps / (JUMPS_PER_MIN_ZERO * Math.max(1, s.levelSec / 60))) : null,
    };
    let total = 0;
    let weight = 0;
    for (const c of CRITERIA) {
        const v = sub[c];
        if (v === null) continue;
        total += v * WEIGHTS[c];
        weight += WEIGHTS[c];
    }
    const bonus = Math.min(BLEND_BONUS_MAX, s.blends * BLEND_BONUS);
    const score = s.mixSec > 0 && weight > 0 ? Math.max(0, Math.min(100, Math.round((total / weight) * 100) + bonus)) : null;

    const weak = CRITERIA.filter((c) => sub[c] !== null && (sub[c] as number) < TIP_BELOW[c]).sort((a, b) => (sub[a] as number) - (sub[b] as number));
    const tips: TipId[] = weak.map((c) => TIP_OF[c]);
    if (s.blends > 0) tips.push("good_blend");
    return { score, sub, tips: tips.slice(0, MAX_TIPS), mixSec: s.mixSec, blends: s.blends, jumps: s.jumps };
}

/** Lit cells (0..cells) of a criterion meter; no data = none. */
export function meterCells(sub: number | null, cells = 5): number {
    return sub === null ? 0 : Math.max(0, Math.min(cells, Math.round(sub * cells)));
}

// ---- building a sample from the app state -------------------------------------------------

export interface MixDeck {
    id: string;
    loaded: boolean;
    playing: boolean;
    volume: number;
    crossfaderAssign: "a" | "thru" | "b";
    /** Track tempo and tempo ratio (used when the clock has no tempo for the deck yet). */
    bpm: number;
    tempo: number;
}

export interface MixClockDeck {
    id: string;
    /** Audible tempo; 0 = unknown. */
    bpm: number;
    /** Fractional beat number at the playhead. */
    beat: number;
    barPhase: number | null;
    /** Key shift in semitones (key match / key shift); absent = 0. */
    keyShift?: number;
}

export interface MixInput {
    decks: readonly MixDeck[];
    crossfader: number;
    /** Master peak level, linear 0..1. */
    masterVu: number;
    /** Master volume 0..1; absent = not tracked. */
    masterVolume?: number;
}

/** A deck quieter than this (channel fader times crossfader side) is not in the mix. */
export const AUDIBLE_MIN = 0.03;

/** Rough gain of a deck's crossfader side (the exact curve does not matter for "audible"). */
export function sideGain(crossfader: number, assign: "a" | "thru" | "b"): number {
    if (assign === "thru") return 1;
    const p = clamp01((crossfader + 1) / 2);
    return assign === "a" ? 1 - p : p;
}

/** Linear peak 0..1 to dBFS; null = silence. */
export function toDb(level: number): number | null {
    return level > 0 ? 20 * Math.log10(Math.min(1, level)) : null;
}

/**
 * The Camelot key a track sounds in after a key shift of `semitones` (rounded): one semitone
 * up is seven steps round the wheel, the letter stays. Unknown key = null.
 */
export function shiftCamelot(key: string | null, semitones: number): string | null {
    const k = parseCamelot(key);
    if (!k) return null;
    const st = Number.isFinite(semitones) ? Math.round(semitones) : 0;
    const n = ((((k.number - 1 + 7 * st) % 12) + 12) % 12) + 1;
    return `${n}${k.letter}`;
}

/** Full travel of a trim knob (dB): one unit in {@link levelControls}. */
const TRIM_SPAN_DB = 36;

const num = (v: number | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * The controls the level tip is about, each scaled so that its full travel is about one unit:
 * crossfader, master volume, then per deck: started or not (loaded and playing), channel
 * fader and trim (`trimDb`, by deck id; the trim is not in the engine snapshot, the UI keeps
 * it).
 */
export function levelControls(mix: MixInput, trimDb: Readonly<Record<string, number>> = {}): number[] {
    const out = [num(mix.crossfader, 0) / 2, num(mix.masterVolume, 0)];
    for (const d of mix.decks) out.push(d.loaded && d.playing ? 1 : 0, num(d.volume, 0), num(trimDb[d.id], 0) / TRIM_SPAN_DB);
    return out;
}

/**
 * One sample from the mixer snapshot, the clock (per-deck tempo and beat) and the track keys.
 * The two decks judged are the first two that play and are audible. Keys follow the key shift
 * (not the pitch change of a tempo fader without key lock: under a semitone up to 5.9 %).
 * `trimDb` = the trim of each deck by id (see {@link levelControls}).
 */
export function buildSample(t: number, mix: MixInput, clock: readonly MixClockDeck[] | null, keys: Readonly<Record<string, string | null>>, trimDb: Readonly<Record<string, number>> = {}): PracticeSample {
    const inMix = mix.decks.filter((d) => d.loaded && d.playing && d.volume * sideGain(mix.crossfader, d.crossfaderAssign) > AUDIBLE_MIN);
    const sample: PracticeSample = { t, bpmA: null, bpmB: null, phaseErrBeats: null, keyA: null, keyB: null, masterDb: toDb(mix.masterVu), crossfader: mix.crossfader, controls: levelControls(mix, trimDb) };
    const [a, b] = inMix;
    if (!a || !b) return sample;
    const ca = clock?.find((c) => c.id === a.id) ?? null;
    const cb = clock?.find((c) => c.id === b.id) ?? null;
    const bpm = (d: MixDeck, c: MixClockDeck | null): number | null => (c && c.bpm > 0 ? c.bpm : d.bpm > 0 && d.tempo > 0 ? d.bpm * d.tempo : null);
    sample.bpmA = bpm(a, ca);
    sample.bpmB = bpm(b, cb);
    if (ca && cb) {
        // Half / double time: the same fold as the tempo, or a locked 87 against 174 BPM mix
        // would read as "beats apart" on every other beat.
        const factor = validBpm(sample.bpmA) && validBpm(sample.bpmB) ? tempoFold(sample.bpmA, sample.bpmB).factor : 1;
        if (Number.isFinite(ca.beat) && Number.isFinite(cb.beat)) sample.phaseErrBeats = foldedPhaseError(ca.beat, cb.beat, factor);
        else if (ca.barPhase !== null && cb.barPhase !== null) sample.phaseErrBeats = foldedPhaseError(ca.barPhase, cb.barPhase, factor);
    }
    sample.keyA = shiftCamelot(keys[a.id] ?? null, ca?.keyShift ?? 0);
    sample.keyB = shiftCamelot(keys[b.id] ?? null, cb?.keyShift ?? 0);
    return sample;
}
