/**
 * Pure helpers for the Decks 1.x performance controls (WP19-05/06/10):
 * beat-fraction labels, Camelot key shifting, routing clamps and the
 * clock → per-deck flag reconciliation. No React, no Tauri: unit-tested with
 * `node --test` (see `perf.test.ts`).
 */

import type { ClockState, DeckId, RoutingConfig } from "../bridge/types";

/** Beat-jump sizes offered on every deck. */
export const BEAT_JUMP_SIZES = [1, 2, 4, 8, 16, 32] as const;

/** Beat FX fractions (1/8 .. 4 beats). */
export const BEAT_FX_FRACTIONS = [0.125, 0.25, 0.5, 1, 2, 4] as const;

/** Key shift range accepted by the engine (semitones). */
export const KEY_SHIFT_MAX = 12;

/** Max per-output latency compensation (ms), matches Rust `MAX_COMP_MS`. */
export const MAX_COMP_MS = 250;

/** Format a beat count as a musical fraction: 0.125 → "1/8", 2 → "2", 0.75 → "3/4". */
export function formatBeats(beats: number): string {
    if (!Number.isFinite(beats) || beats <= 0) return "—";
    if (Number.isInteger(beats)) return String(beats);
    for (const den of [2, 4, 8, 16, 32]) {
        const num = beats * den;
        if (Math.abs(num - Math.round(num)) < 1e-9) {
            const n = Math.round(num);
            return n % den === 0 ? String(n / den) : `${n}/${den}`;
        }
    }
    return beats.toFixed(2);
}

/** Clamp + round a key shift to whole semitones within ±12. */
export function clampKeyShift(semitones: number): number {
    if (!Number.isFinite(semitones)) return 0;
    return Math.max(-KEY_SHIFT_MAX, Math.min(KEY_SHIFT_MAX, Math.round(semitones)));
}

/** Signed semitone label: 0 → "0", 2 → "+2", -1.5 → "-1.5". */
export function formatSemitones(semitones: number): string {
    if (!Number.isFinite(semitones) || Math.abs(semitones) < 1e-6) return "0";
    const v = Number.isInteger(semitones) ? String(semitones) : semitones.toFixed(1);
    return semitones > 0 ? `+${v}` : v;
}

/**
 * Shift a Camelot key by whole semitones. One semitone up = +7 on the Camelot
 * wheel (fifths), letter (A minor / B major) unchanged. Returns null for an
 * unparseable key or a non-integer shift.
 */
export function shiftCamelot(key: string | null | undefined, semitones: number): string | null {
    if (!key) return null;
    const m = /^\s*(\d{1,2})\s*([ABab])\s*$/.exec(key);
    if (!m) return null;
    const num = Number(m[1]);
    if (num < 1 || num > 12 || !Number.isInteger(semitones)) return null;
    const shifted = ((((num - 1 + 7 * semitones) % 12) + 12) % 12) + 1;
    return `${shifted}${(m[2] ?? "A").toUpperCase()}`;
}

export const DEFAULT_ROUTING: RoutingConfig = {
    mode: "auto",
    cueMix: 0,
    headphoneLevel: 0.7,
    splitMono: false,
    boothLevel: 0,
    masterLatencyMs: 0,
    headphoneLatencyMs: 0,
    boothLatencyMs: 0,
};

function clamp(v: number, lo: number, hi: number, fallback: number): number {
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** Routing reducer: merge a patch and clamp every field to the engine's ranges. */
export function applyRouting(cfg: RoutingConfig, patch: Partial<RoutingConfig>): RoutingConfig {
    const n = { ...cfg, ...patch };
    return {
        mode: n.mode === "stereo" || n.mode === "fourChannel" ? n.mode : "auto",
        cueMix: clamp(n.cueMix, 0, 1, cfg.cueMix),
        headphoneLevel: clamp(n.headphoneLevel, 0, 1.5, cfg.headphoneLevel),
        splitMono: Boolean(n.splitMono),
        boothLevel: clamp(n.boothLevel, 0, 1.5, cfg.boothLevel),
        masterLatencyMs: clamp(n.masterLatencyMs, 0, MAX_COMP_MS, cfg.masterLatencyMs),
        headphoneLatencyMs: clamp(n.headphoneLatencyMs, 0, MAX_COMP_MS, cfg.headphoneLatencyMs),
        boothLatencyMs: clamp(n.boothLatencyMs, 0, MAX_COMP_MS, cfg.boothLatencyMs),
    };
}

/** 4-channel mapping (ch1/2 master, ch3/4 headphones) needs ≥4 output channels. */
export function fourChannelAvailable(channels: number | null | undefined): boolean {
    return typeof channels === "number" && channels >= 4;
}

/** Engine-owned per-deck flags mirrored from `engine_clock_state`. */
export interface DeckClockFlags {
    syncLock: boolean;
    quantize: boolean;
    slip: boolean;
    keyShift: number;
}

/**
 * Merge the clock snapshot's per-deck flags into `current`. Returns the SAME
 * object when nothing changed so a 30 Hz poll does not re-render every deck.
 */
export function reconcileDeckFlags<T extends DeckClockFlags>(
    current: Record<DeckId, T>,
    clock: Pick<ClockState, "decks"> | null,
): Record<DeckId, T> {
    if (!clock) return current;
    let next: Record<DeckId, T> | null = null;
    for (const d of clock.decks) {
        const cur = current[d.id];
        if (!cur) continue;
        if (
            cur.syncLock === d.syncLock &&
            cur.quantize === d.quantize &&
            cur.slip === d.slip &&
            Math.abs(cur.keyShift - d.keyShift) < 1e-6
        ) {
            continue;
        }
        next ??= { ...current };
        next[d.id] = { ...cur, syncLock: d.syncLock, quantize: d.quantize, slip: d.slip, keyShift: d.keyShift };
    }
    return next ?? current;
}

/** Current beat inside the bar (0-based) from a clock snapshot, or null. */
export function beatInBar(clock: Pick<ClockState, "barPhase" | "beat" | "beatsPerBar"> | null): number | null {
    if (!clock) return null;
    const bpb = clock.beatsPerBar > 0 ? clock.beatsPerBar : 4;
    const pos = clock.barPhase ?? ((clock.beat % bpb) + bpb) % bpb;
    return Number.isFinite(pos) ? Math.floor(pos) % bpb : null;
}
