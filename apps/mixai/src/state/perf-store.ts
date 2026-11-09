/**
 * Decks 1.x performance state (WP19-05/06/10) that is not part of the Rust
 * `MixerState` snapshot: sync lock / quantize / slip / key shift / reverse,
 * beat-jump size, master clock, routing matrix, colour FX and the beat FX unit.
 *
 * Commands are issued optimistically; engine-owned flags (sync lock, quantize,
 * slip, key shift) are reconciled from `engine_clock_state` by the clock poll.
 */

import { create } from "zustand";
import { engine } from "@/bridge/engine";
import type {
    AudioDevice,
    BeatFxKind,
    ClockSource,
    ClockState,
    ColorFxKind,
    DeckId,
    KeyMatchRequest,
    RoutingConfig,
} from "@/bridge/types";
import { applyRouting, clampKeyShift, DEFAULT_ROUTING, reconcileDeckFlags, type DeckClockFlags } from "@/lib/perf";

export interface DeckPerf extends DeckClockFlags {
    reverse: boolean;
    jumpSize: number;
    colorFx: ColorFxKind;
    colorParam: number;
}

export interface BeatFxUnit {
    kind: Exclude<BeatFxKind, "none">;
    on: boolean;
    wet: number;
    beats: number;
    deck: DeckId;
}

function initialDeck(): DeckPerf {
    return {
        syncLock: false,
        quantize: true,
        slip: false,
        keyShift: 0,
        reverse: false,
        jumpSize: 4,
        colorFx: "none",
        colorParam: 0,
    };
}

interface PerfStore {
    decks: Record<DeckId, DeckPerf>;
    clock: ClockState | null;
    clockSource: ClockSource;
    internalBpm: number;
    routing: RoutingConfig;
    /** Output channel count of the master device (null = unknown / browser). */
    outputChannels: number | null;
    beatFx: BeatFxUnit;

    phaseSync: (deck: DeckId) => void;
    setSyncLock: (deck: DeckId, on: boolean) => void;
    setQuantize: (deck: DeckId, on: boolean) => void;
    setSlip: (deck: DeckId, on: boolean) => void;
    setReverse: (deck: DeckId, on: boolean) => void;
    setJumpSize: (deck: DeckId, beats: number) => void;
    beatJump: (deck: DeckId, dir: -1 | 1) => void;
    setKeyShift: (deck: DeckId, semitones: number) => void;
    keyMatch: (deck: DeckId, keyName: string | null, masterKeyName?: string | null) => Promise<void>;
    setClockSource: (source: ClockSource) => void;
    setInternalBpm: (bpm: number) => void;
    setClock: (clock: ClockState | null) => void;
    patchRouting: (patch: Partial<RoutingConfig>) => void;
    loadRouting: () => Promise<void>;
    setOutputDevices: (devices: AudioDevice[]) => void;
    setColorFx: (deck: DeckId, kind: ColorFxKind, param?: number) => void;
    patchBeatFx: (patch: Partial<BeatFxUnit>) => void;
}

function sendBeatFx(fx: BeatFxUnit, previousDeck?: DeckId): void {
    // Moving the unit to another deck: switch it off on the old one first.
    if (previousDeck && previousDeck !== fx.deck) {
        void engine.setBeatFx({ deck: previousDeck, kind: "none", wet: 0, beats: fx.beats });
    }
    void engine.setBeatFx({ deck: fx.deck, kind: fx.on ? fx.kind : "none", wet: fx.wet, beats: fx.beats });
}

export const usePerfStore = create<PerfStore>((set, get) => {
    const patchDeck = (deck: DeckId, patch: Partial<DeckPerf>) =>
        set((s) => ({ decks: { ...s.decks, [deck]: { ...s.decks[deck], ...patch } } }));

    return {
        decks: { a: initialDeck(), b: initialDeck(), c: initialDeck(), d: initialDeck() },
        clock: null,
        clockSource: "auto",
        internalBpm: 128,
        routing: DEFAULT_ROUTING,
        outputChannels: null,
        beatFx: { kind: "echo", on: false, wet: 0.5, beats: 0.5, deck: "a" },

        phaseSync: (deck) => {
            void engine.phaseSync(deck, get().decks[deck].syncLock);
        },
        setSyncLock: (deck, on) => {
            patchDeck(deck, { syncLock: on });
            // Engaging lock also aligns once; releasing it just stops following.
            void (on ? engine.phaseSync(deck, true) : engine.setSyncLock(deck, false));
        },
        setQuantize: (deck, on) => {
            patchDeck(deck, { quantize: on });
            void engine.setQuantize(deck, on);
        },
        setSlip: (deck, on) => {
            patchDeck(deck, { slip: on });
            void engine.setSlip(deck, on);
        },
        setReverse: (deck, on) => {
            patchDeck(deck, { reverse: on });
            void engine.setReverse(deck, on);
        },
        setJumpSize: (deck, beats) => patchDeck(deck, { jumpSize: beats }),
        beatJump: (deck, dir) => {
            void engine.beatJump(deck, dir * get().decks[deck].jumpSize);
        },
        setKeyShift: (deck, semitones) => {
            const st = clampKeyShift(semitones);
            patchDeck(deck, { keyShift: st });
            void engine.setKeyShift(deck, st);
        },
        keyMatch: async (deck, keyName, masterKeyName) => {
            const req: KeyMatchRequest = { deck };
            if (keyName) req.keyName = keyName;
            if (masterKeyName) req.masterKeyName = masterKeyName;
            const shift = await engine.keyMatch(req).catch(() => null);
            if (typeof shift === "number") patchDeck(deck, { keyShift: shift });
        },
        setClockSource: (source) => {
            set({ clockSource: source });
            void engine.setMasterClock(source === "internal" ? { source, bpm: get().internalBpm } : { source });
        },
        setInternalBpm: (bpm) => {
            if (!Number.isFinite(bpm)) return;
            const v = Math.max(20, Math.min(300, bpm));
            set({ internalBpm: v });
            void engine.setMasterClock({ bpm: v });
        },
        setClock: (clock) =>
            set((s) => {
                const decks = reconcileDeckFlags(s.decks, clock);
                const clockSource = clock?.configured ?? s.clockSource;
                return { clock, decks, clockSource };
            }),
        patchRouting: (patch) => {
            const routing = applyRouting(get().routing, patch);
            set({ routing });
            void engine.setRouting(routing);
        },
        loadRouting: async () => {
            const r = await engine.getRouting().catch(() => null);
            if (r) set({ routing: applyRouting(DEFAULT_ROUTING, r) });
        },
        setOutputDevices: (devices) => {
            const dev = devices.find((d) => d.isDefault) ?? devices[0];
            set({ outputChannels: dev ? dev.channels : null });
        },
        setColorFx: (deck, kind, param) => {
            const p = Math.max(-1, Math.min(1, param ?? get().decks[deck].colorParam));
            patchDeck(deck, { colorFx: kind, colorParam: p });
            void engine.setColorFx(deck, kind, p);
        },
        patchBeatFx: (patch) => {
            const prev = get().beatFx;
            const next: BeatFxUnit = {
                ...prev,
                ...patch,
                wet: Math.max(0, Math.min(1, patch.wet ?? prev.wet)),
            };
            set({ beatFx: next });
            sendBeatFx(next, prev.deck);
        },
    };
});
