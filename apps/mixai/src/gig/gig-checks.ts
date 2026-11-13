/**
 * The checklist run (the store behind the "Checklist" tab of the gig popover). Classification
 * is pure and lives in ./gig-core.ts; this module only gathers the inputs.
 *
 * Nothing here runs by itself: `refresh()` is called when the popover opens (one round of
 * one-shot questions to the engine and the shell, no timer) and `run()` by the "Run checks"
 * button (the same round plus the 10 s dropout measurement). The popover cancels a running
 * measurement when it closes, so nothing is measured while it is closed.
 *
 * Every row carries the time ITS result was taken (`at`): a refresh of the instant checks does
 * not make an older dropout measurement look new.
 *
 * Dropout measurement: the engine's overrun counter counts since the engine started and has
 * no reset, so the window is "counter at the end minus counter at the start"; the peak audio
 * load is the highest value among the engine snapshots of the window (about 30 a second). It
 * measures whatever is going on: with the decks stopped that is the idle engine only, and the
 * result says so. A cancelled measurement (the Cancel button, or closing the popover) leaves
 * the last finished result in place, with its own time.
 */
import { create } from "zustand";
import { engine } from "@/bridge/engine";
import { gig } from "@/bridge/gig";
import { devExpose } from "@/dev/expose";
import { useLibraryPool } from "@/library/pool-store";
import { useRemoteStore } from "@/remote/remote-store";
import { useCompanionStore } from "@/state/companion-store";
import { useMixerStore } from "@/state/mixer-store";
import { useRecordingStore } from "@/state/recording-store";
import { useStatusStore } from "@/shell/status-store";
import {
    DROPOUT_MS,
    REASONS,
    classifyAudio,
    classifyController,
    classifyDisk,
    classifyDropouts,
    classifyLibrary,
    classifyPower,
    folderGone,
    folderOf,
    parseSystem,
    type CheckId,
    type CheckResult,
    type Reason,
} from "./gig-core";

/** localStorage: folder of the last recording (where the next one most likely goes). Not a setting. */
export const REC_DIR_KEY = "mixai-gig-recdir";

/** Remember the folder of a recording that started (called by gig-runtime when the recording store gets a path). */
export function rememberRecordingPath(file: string | null): void {
    const dir = folderOf(file);
    if (!dir) return;
    try {
        localStorage.setItem(REC_DIR_KEY, dir);
    } catch {
        // storage unavailable: the shell's default folder is measured instead
    }
}

/**
 * The folder whose volume the disk check measures: the folder of the recording that runs now,
 * else the folder of the last recording this app made, else null = the shell's default (the
 * user's Documents folder, where the save dialog starts on a first run).
 */
export function recordingFolder(): string | null {
    const now = folderOf(useRecordingStore.getState().path);
    if (now) return now;
    try {
        return localStorage.getItem(REC_DIR_KEY);
    } catch {
        return null;
    }
}

export interface ChecksState {
    results: Partial<Record<CheckId, CheckResult>>;
    /** Epoch ms each result was taken. */
    at: Partial<Record<CheckId, number>>;
    /** Epoch ms of the last finished round (null = never). */
    takenAt: number | null;
    /** A round of one-shot questions is on its way. */
    busy: boolean;
    /** Whole seconds the dropout measurement still runs (0 = not measuring). */
    secondsLeft: number;
    refresh: () => Promise<void>;
    run: () => Promise<void>;
    cancel: () => void;
}

const fixed = (reason: Reason): CheckResult => ({ state: REASONS[reason], reason, vars: {} });

/**
 * Bumped by every new round (refresh or run): a late answer of an older round is dropped.
 * Cancel does not bump it; it ends the measurement through `stopMeasure`.
 */
let round = 0;
let stopMeasure: ((cancelled: boolean) => void) | null = null;

function put(id: CheckId, r: CheckResult): void {
    useGigChecks.setState((s) => ({ results: { ...s.results, [id]: r }, at: { ...s.at, [id]: Date.now() } }));
}

/** One round of one-shot questions (audio, power + disk, library, controller). Never throws. */
async function instant(my: number): Promise<void> {
    const mixer = useMixerStore.getState();
    const native = mixer.native;
    const sampleRate = mixer.sampleRate;
    const quiet = <T,>(p: Promise<T | null>): Promise<T | null> => p.catch(() => null);
    const live = () => my === round;

    const audio = (async () => {
        const [info, devices] = await Promise.all([quiet(engine.audioOutputInfo()), quiet(engine.listAudioDevices())]);
        if (!live()) return;
        const latencyMs = useStatusStore.getState().latencyMs || useMixerStore.getState().latencyMs || info?.latencyMs || 0;
        put("audio", classifyAudio({ native, info, devices, latencyMs }));
    })();

    const system = (async () => {
        // null = no such command in this shell (or no shell): both rows say "not available".
        const folder = recordingFolder();
        let sys = parseSystem(await quiet(gig.systemStatus(folder)));
        // The remembered folder is gone (a stick that was pulled, a folder that was renamed):
        // the default folder is measured instead of "unknown" for good.
        if (sys && folder !== null && folderGone(sys.disk.error)) {
            const fallback = parseSystem(await quiet(gig.systemStatus(null)));
            if (fallback) sys = { power: sys.power, disk: fallback.disk };
        }
        if (!live()) return;
        put("power", classifyPower(sys?.power ?? null));
        put("disk", classifyDisk(sys?.disk ?? null, info_rate(sampleRate)));
    })();

    const library = (async () => {
        const status = native ? await quiet(engine.companionStatus()) : null;
        if (!live()) return;
        const pool = useLibraryPool.getState();
        put(
            "library",
            classifyLibrary({
                native,
                status,
                loaded: pool.tracks.length,
                query: pool.query,
                total: pool.total,
                fetched: pool.fetched,
                baseUrl: useCompanionStore.getState().baseUrl,
                // The only address of this computer the app knows without asking for anything new:
                // the one its own Connect server reports while it runs.
                selfHosts: [useRemoteStore.getState().host],
            }),
        );
    })();

    const controller = (async () => {
        const [ble, ports] = native ? await Promise.all([quiet(engine.bleMidiStatus()), quiet(engine.listMidiInputs())]) : [null, null];
        if (!live()) return;
        put("controller", classifyController({ native, ble: ble ? { name: ble[0], connected: ble[1] } : null, midiPorts: ports }));
    })();

    await Promise.all([audio, system, library, controller]);
}

/** The engine's rate when it reported one (the recorder writes at that rate). */
function info_rate(sampleRate: number): number {
    return sampleRate > 0 ? sampleRate : 48000;
}

/** A dropout result that came from a finished measurement (not "cancelled", not "not run"). */
function measured(r: CheckResult | undefined): boolean {
    return !!r && r.reason !== "dropouts.cancelled" && r.reason !== "dropouts.notRun";
}

/** The dropout window. Resolves with the result, or null when there is nothing to put (superseded, or cancelled with an earlier result to keep). */
function measure(my: number): Promise<CheckResult | null> {
    const m0 = useMixerStore.getState();
    if (!m0.native) return Promise.resolve(classifyDropouts({ native: false, overrunsBefore: 0, overrunsAfter: 0, peakLoad: 0, playing: false }));
    return new Promise((resolve) => {
        const before = m0.overruns ?? 0;
        let peak = m0.dspLoad ?? 0;
        let playing = m0.decks.some((d) => d.playing);
        const off = useMixerStore.subscribe((s) => {
            const load = s.dspLoad ?? 0;
            if (load > peak) peak = load;
            if (!playing && s.decks.some((d) => d.playing)) playing = true;
        });
        const t0 = performance.now();
        const tick = setInterval(() => {
            const left = Math.max(0, Math.ceil((DROPOUT_MS - (performance.now() - t0)) / 1000));
            if (useGigChecks.getState().secondsLeft !== left) useGigChecks.setState({ secondsLeft: left });
        }, 250);
        const end = setTimeout(() => stop(false), DROPOUT_MS);
        function stop(cancelled: boolean): void {
            off();
            clearInterval(tick);
            clearTimeout(end);
            stopMeasure = null;
            useGigChecks.setState({ secondsLeft: 0 });
            if (my !== round && !cancelled) return resolve(null);
            // Cancelled: an earlier finished result stays (with its own time); with none, the row says so.
            if (cancelled) return resolve(measured(useGigChecks.getState().results.dropouts) ? null : fixed("dropouts.cancelled"));
            const m1 = useMixerStore.getState();
            resolve(classifyDropouts({ native: true, overrunsBefore: before, overrunsAfter: m1.overruns ?? 0, peakLoad: Math.max(peak, m1.dspLoad ?? 0), playing }));
        }
        stopMeasure = stop;
        useGigChecks.setState({ secondsLeft: Math.ceil(DROPOUT_MS / 1000) });
    });
}

export const useGigChecks = create<ChecksState>((set, get) => ({
    results: {},
    at: {},
    takenAt: null,
    busy: false,
    secondsLeft: 0,
    refresh: async () => {
        // A full run is under way: it answers the same questions.
        if (get().busy || get().secondsLeft > 0) return;
        const my = ++round;
        set({ busy: true });
        try {
            await instant(my);
        } finally {
            if (my === round) set({ busy: false, takenAt: Date.now() });
        }
    },
    run: async () => {
        if (get().secondsLeft > 0) return;
        const my = ++round;
        set({ busy: true });
        const window = measure(my);
        try {
            await instant(my);
        } finally {
            if (my === round) set({ busy: false });
        }
        const dropouts = await window;
        if (dropouts) put("dropouts", dropouts);
        if (my === round) set({ takenAt: Date.now() });
    },
    cancel: () => {
        stopMeasure?.(true);
    },
}));

devExpose("gigChecks", useGigChecks);
