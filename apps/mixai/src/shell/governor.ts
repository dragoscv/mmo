/**
 * Animation governor: keeps the UI smooth during a set. It samples frame times
 * and switches the app into reduced motion (`data-motion-governor="reduced"` on
 * <html>, read by CSS and the motion helpers) when the UI drops under ~55 fps
 * for a while; it switches back after a sustained good period. Pure state
 * machine so it is unit-tested (governor.test.ts). The audio engine is native
 * and unaffected either way; this only protects the UI frame budget.
 */

export interface GovernorState {
    /** Exponential moving average of frame time (ms). */
    avgMs: number;
    reduced: boolean;
    /** ms spent continuously on the "wrong" side of the threshold. */
    streakMs: number;
}

export const GOVERNOR = {
    /** Above this average frame time (~55 fps) we count towards reducing. */
    slowMs: 18.2,
    /** Below this (~58 fps) we count towards restoring. */
    fastMs: 17.2,
    reduceAfterMs: 1500,
    restoreAfterMs: 8000,
    alpha: 0.1,
    /** Frames longer than this are pauses (tab hidden, debugger), ignored. */
    ignoreAboveMs: 250,
} as const;

export const initialGovernor: GovernorState = { avgMs: 16.7, reduced: false, streakMs: 0 };

export function stepGovernor(s: GovernorState, frameMs: number): GovernorState {
    if (!(frameMs > 0) || frameMs > GOVERNOR.ignoreAboveMs) return s;
    const avgMs = s.avgMs + GOVERNOR.alpha * (frameMs - s.avgMs);
    if (!s.reduced) {
        const streakMs = avgMs > GOVERNOR.slowMs ? s.streakMs + frameMs : 0;
        if (streakMs >= GOVERNOR.reduceAfterMs) return { avgMs, reduced: true, streakMs: 0 };
        return { avgMs, reduced: false, streakMs };
    }
    const streakMs = avgMs < GOVERNOR.fastMs ? s.streakMs + frameMs : 0;
    if (streakMs >= GOVERNOR.restoreAfterMs) return { avgMs, reduced: false, streakMs: 0 };
    return { avgMs, reduced: true, streakMs };
}

export function fpsOf(avgMs: number): number {
    return avgMs > 0 ? Math.round(1000 / avgMs) : 0;
}
