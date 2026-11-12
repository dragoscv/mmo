/**
 * Typed wrappers around the co-pilot commands of `src-tauri/src/copilot.rs` (WP19-39) and the
 * `copilot://progress` event. Same `call` pattern as `bridge/engine.ts`: dynamic import of the
 * Tauri API, `null` outside Tauri (plain `vite`, tests). A command the running shell does not
 * know yet rejects with the Tauri "command not found" message: the store turns that into
 * "not available".
 */
import type { DeckId } from "./types";

/** Track features the co-pilot works on (camelCase mirror of Rust `TrackFeat`). */
export interface TrackFeat {
    id: string;
    title: string;
    artist: string;
    /** Tempo of the track itself (null = unknown). */
    bpm: number | null;
    /** Camelot (`8A`); null = unknown. */
    key: string | null;
    /** 1..10; null = not analysed. */
    energy: number | null;
    durationSec: number;
    firstBeatSec: number;
    downbeatOffset: number;
    lufs: number | null;
    hasStems: boolean;
}

export interface Candidate {
    track: TrackFeat;
    /** Minutes since it was last played tonight (null = not played). */
    playedMinutesAgo: number | null;
}

export type EnergyDirection = "hold" | "up" | "down";

/** A ranked suggestion (mirror of Rust `RankedOut`). */
export interface Ranked {
    id: string;
    score: number;
    key: number;
    tempo: number;
    energy: number;
    /** Reason tags: `key_same`, `tempo_close`, `energy_up`, `recently_played`, … (translated by the UI). */
    reasons: string[];
    tempoRatio: number | null;
}

export type TransitionStyle = "bass_swap" | "filter_sweep" | "echo_out" | "stem_swap" | "cut";

/** A transition plan (mirror of Rust `PlanInfo`). Pass the whole object back to `run`. */
export interface PlanInfo {
    style: TransitionStyle;
    bars: number;
    /** Start on the outgoing track, in seconds. */
    startSec: number;
    beatsUntilStart: number;
    toCueSec: number;
    toTempoRatio: number;
    /** Editable automation JSON (docs/decks/transitions.md). */
    automationJson: string;
    reasons: string[];
    fromDeck: DeckId;
    toDeck: DeckId;
    lengthBeats: number;
}

/** State of a running transition (`copilot://progress`, mirror of Rust `Progress`). */
export interface Progress {
    running: boolean;
    /** 0..1 of the automation length (0 while waiting for the start). */
    progress: number;
    done: boolean;
    /** Ended by `cancel` or because the audio engine stopped. */
    cancelled: boolean;
    /** The start (next phrase) has not been reached yet. */
    waiting: boolean;
    beatsUntilStart: number;
    lengthBeats: number;
    fromDeck: DeckId;
    toDeck: DeckId;
    /** Commands the engine refused (first eight). */
    errors: string[];
}

export type WarningCode = "ending_without_next" | "plan_does_not_fit" | "tempo_gap" | "key_clash" | "loudness_jump" | "no_grid";

/** One set-safety warning (mirror of Rust `WarningOut`; only the numbers of its code are present). */
export interface SafetyWarning {
    code: WarningCode;
    /** 2 = act now, 1 = heads-up. */
    severity: 1 | 2;
    barsLeft?: number;
    needed?: number;
    percent?: number;
    from?: string;
    to?: string;
    deltaLu?: number;
}

export type IntentAction = "mix_next" | "suggest" | "cancel" | "play" | "pause" | "sync" | "loop";

/** A recognised typed command (mirror of Rust `IntentOut`). */
export interface Intent {
    action: IntentAction;
    bars: number | null;
    style: TransitionStyle | null;
    energy: EnergyDirection | null;
    deck: DeckId | null;
    beats: number | null;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn | null = null;

async function getInvoke(): Promise<InvokeFn | null> {
    if (invokeImpl) return invokeImpl;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        const mod = await import("@tauri-apps/api/core");
        invokeImpl = mod.invoke as InvokeFn;
        return invokeImpl;
    }
    return null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
    const invoke = await getInvoke();
    if (!invoke) {
        if (import.meta.env?.DEV) console.debug(`[mixai mock] ${cmd}`, args ?? {});
        return null;
    }
    return invoke<T>(cmd, args);
}

/**
 * True when the running shell predates the co-pilot: Tauri's "Command copilot_x not found", or
 * the answer of the placeholder command older shells registered.
 */
export function isUnknownCommand(err: unknown): boolean {
    const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    if (/not available in this build/i.test(text)) return true;
    return /not found|not allowed|unknown command/i.test(text) && /copilot_/.test(text);
}

export const copilot = {
    /** Top `limit` next tracks after `playing` (default 8), with reason tags. */
    rank(playing: TrackFeat, candidates: Candidate[], energy: EnergyDirection = "hold", limit = 8): Promise<Ranked[] | null> {
        return call<Ranked[]>("copilot_rank", { playing, candidates, energy, limit });
    },

    /** Plan a transition from `from` (on `fromDeck`, playhead at `fromPosSec`) to `to` (on `toDeck`). */
    plan(req: {
        from: TrackFeat;
        to: TrackFeat;
        fromDeck: DeckId;
        toDeck: DeckId;
        fromPosSec: number;
        bars?: number | null;
        style?: TransitionStyle | null;
    }): Promise<PlanInfo | null> {
        return call<PlanInfo>("copilot_plan", {
            from: req.from,
            to: req.to,
            fromDeck: req.fromDeck,
            toDeck: req.toDeck,
            fromPosSec: req.fromPosSec,
            bars: req.bars ?? null,
            style: req.style ?? null,
        });
    },

    /** Run a plan (the object `plan` returned, automation possibly edited). Progress follows on the event. */
    run(plan: PlanInfo): Promise<Progress | null> {
        return call<Progress>("copilot_run", { planJson: JSON.stringify(plan), fromDeck: plan.fromDeck, toDeck: plan.toDeck });
    },

    /** Stop the running transition (decks keep their values). Resolves to whether one ran. */
    cancel(): Promise<boolean | null> {
        return call<boolean>("copilot_cancel");
    },

    /** The running transition, if any (after a UI reload). */
    status(): Promise<Progress | null> {
        return call<Progress | null>("copilot_status");
    },

    /** 32-bar look-ahead warnings for the playing deck, most severe first. */
    safety(req: { playing: TrackFeat; positionSec: number; tempoRatio: number; next: TrackFeat | null; plannedBars: number | null }): Promise<SafetyWarning[] | null> {
        return call<SafetyWarning[]>("copilot_safety", req);
    },

    /** Parse a typed RO / EN command offline; null = not a command (or no engine). */
    intent(text: string): Promise<Intent | null> {
        return call<Intent | null>("copilot_intent", { text });
    },

    /** JSON Schema of an intent (for a later codai structured-output call). */
    intentSchema(): Promise<string | null> {
        return call<string>("copilot_intent_schema");
    },
};

type UnlistenFn = () => void;

/** Subscribe to `copilot://progress` (10 Hz while a transition runs, one event when it ends). */
export async function subscribeCopilotProgress(onProgress: (p: Progress) => void): Promise<UnlistenFn> {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
        return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    return listen<Progress>("copilot://progress", (e) => {
        onProgress(e.payload);
    });
}
