/**
 * State of LAN tempo sync in the UI. The Rust side (`src-tauri/src/link.rs`) owns the session
 * and the engine clock; this store mirrors its status (`link://state`, 4 Hz while sync runs)
 * and sends the few commands of the popover. Components select single values, so a status that
 * repeats the same numbers renders nothing.
 */
import { create } from "zustand";
import { link, subscribeLinkState, type LinkStartOptions, type LinkStatus } from "@/bridge/link";
import { devExpose } from "@/dev/expose";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { LINK_OFF, MAX_BPM, MIN_BPM, errorKey, isUnavailable, liveError, normalizeStatus, pinValid, type LinkErrorKey } from "./link-math";

/** `unknown` until the shell answered once; `no` = a shell without tempo sync, or no shell. */
export type LinkAvailability = "unknown" | "yes" | "no";

interface LinkStore {
    status: LinkStatus;
    available: LinkAvailability;
    /** A start or stop is on its way. */
    busy: boolean;
    error: LinkErrorKey | null;
    /** PIN typed in the popover (kept while the app runs; never stored). */
    pin: string;

    /** Subscribe to the status event (once) and ask for the current status. */
    init: () => void;
    refresh: () => Promise<void>;
    setPin: (pin: string) => void;
    /** `opts` overrides the address / port (tests); the PIN comes from the store. */
    start: (opts?: Omit<LinkStartOptions, "pin">) => Promise<void>;
    stop: () => Promise<void>;
    /** Propose a session tempo (refused, with the reason, while it follows a playing deck). */
    setTempo: (bpm: number) => Promise<void>;
    /** Shift our phase against the session by `beats` (a follower's control). */
    nudge: (beats: number) => Promise<void>;
    /** Align every playing deck to the master clock again. */
    realign: () => void;
}

let subscribed = false;

export const useLinkStore = create<LinkStore>((set, get) => {
    /** Run a command and take its answer; false when it did not go through. */
    const run = async (op: () => Promise<LinkStatus | null>): Promise<boolean> => {
        try {
            const answer = await op();
            if (answer === null) {
                set({ available: "no", status: LINK_OFF });
                return false;
            }
            set({ available: "yes", status: normalizeStatus(answer), error: null });
            return true;
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (isUnavailable(message)) set({ available: "no", status: LINK_OFF, error: null });
            else set({ error: errorKey(message) });
            return false;
        }
    };

    return {
        status: LINK_OFF,
        available: "unknown",
        busy: false,
        error: null,
        pin: "",

        init: () => {
            if (!subscribed) {
                subscribed = true;
                void subscribeLinkState((payload) => {
                    const status = normalizeStatus(payload);
                    // A refusal whose cause is gone (the deck stopped, the lead moved on) goes too.
                    set({ available: "yes", status, error: liveError(get().error, status) });
                }).catch(() => {
                    subscribed = false;
                });
            }
            void get().refresh();
        },
        refresh: async () => {
            await run(() => link.status());
        },
        setPin: (pin) => set({ pin, error: null }),
        start: async (opts) => {
            const { pin, busy } = get();
            if (busy) return;
            if (!pinValid(pin)) {
                set({ error: "link.err.pin" });
                return;
            }
            set({ busy: true, error: null });
            await run(() => link.start({ ...opts, pin }));
            set({ busy: false });
        },
        stop: async () => {
            if (get().busy) return;
            set({ busy: true, error: null });
            await run(() => link.stop());
            set({ busy: false });
        },
        setTempo: async (bpm) => {
            if (get().status.tempoLocked) {
                set({ error: "link.err.tempoLocked" });
                return;
            }
            if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
                set({ error: "link.err.bpm" });
                return;
            }
            await run(() => link.set({ bpm }));
        },
        nudge: async (beats) => {
            if (!Number.isFinite(beats)) return;
            if (get().status.leader) {
                set({ error: "link.err.nudgeLeader" });
                return;
            }
            await run(() => link.set({ nudgeBeats: beats }));
        },
        realign: () => {
            const { phaseSync } = usePerfStore.getState();
            for (const deck of useMixerStore.getState().decks) if (deck.playing) phaseSync(deck.id);
        },
    };
});

devExpose("link", useLinkStore);
