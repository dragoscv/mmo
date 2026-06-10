/**
 * HID mapping store + dispatcher.
 *
 * Holds the active {@link HidPreset} (persisted to localStorage), receives raw
 * `hid://input` reports, and:
 *   1. **Dispatches** mapped controls to engine actions (button edges on press,
 *      axes on value change), reusing the same value-scaling as the Rust MIDI
 *      `map_to_command` so a fader feels identical whether it's MIDI or HID.
 *   2. **Learns** controls by diffing consecutive reports to find which byte /
 *      bit changed, surfacing a candidate the UI can bind to an action.
 *
 * Frontend-only: it orchestrates existing `engine.*` commands and never touches
 * the audio thread directly.
 */

import { create } from "zustand";
import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import type { HidInputEvent } from "@/bridge/types";
import {
    emptyHidPreset,
    reportByte,
    removeHidMapping,
    upsertHidMapping,
    type HidMapping,
    type HidPreset,
} from "@/lib/hid-mapping";

const STORAGE_KEY = "mixai-hid-preset";

/** A control the learn pass detected as having just changed. */
export interface HidLearnCandidate {
    byteIndex: number;
    /** Bit that toggled on (button), or 0 for an axis (whole byte moved). */
    mask: number;
    type: "button" | "axis";
    /** Current value at that byte (for display). */
    value: number;
}

function loadPreset(): HidPreset {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const p = JSON.parse(raw) as HidPreset;
            if (p && Array.isArray(p.mappings)) return p;
        }
    } catch {
        // ignore corrupt storage
    }
    return emptyHidPreset();
}

function persist(preset: HidPreset): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(preset));
    } catch {
        // non-fatal
    }
}

/** Apply one mapped control to the engine. `prev` is the previous report. */
function applyMapping(m: HidMapping, bytes: number[], prev: number[] | null): void {
    if (m.type === "button") {
        // Edge-trigger on press (rising edge), to match MIDI note-on behaviour.
        const now = (reportByte(bytes, m.byteIndex) & m.mask) !== 0;
        const before = prev ? (reportByte(prev, m.byteIndex) & m.mask) !== 0 : false;
        if (now && !before) dispatchButton(m);
        return;
    }
    // Axis: only act when the byte value actually changed.
    const v = reportByte(bytes, m.byteIndex);
    if (prev && reportByte(prev, m.byteIndex) === v) return;
    dispatchAxis(m, v / 255);
}

/** Momentary button actions act on press. Mirrors MIDI note-on dispatch. */
function dispatchButton(m: HidMapping): void {
    const deck = m.deck;
    switch (m.action) {
        case "play": {
            if (!deck) return;
            const d = useMixerStore.getState().deck(deck);
            void (d.playing ? engine.pause(deck) : engine.play(deck));
            return;
        }
        case "cue": {
            if (!deck) return;
            const d = useMixerStore.getState().deck(deck);
            void engine.setCue(deck, !d.cue);
            return;
        }
        case "sync":
            if (deck) void engine.sync(deck);
            return;
        case "loop-in":
            if (deck) void engine.loopIn(deck);
            return;
        case "loop-out":
            if (deck) void engine.loopOut(deck);
            return;
        case "reloop":
            if (deck) void engine.loopToggle(deck);
            return;
        case "loop-halve":
            if (deck) void engine.loopScale(deck, 0.5);
            return;
        case "loop-double":
            if (deck) void engine.loopScale(deck, 2.0);
            return;
        case "beatloop1":
            if (deck) void engine.beatloop(deck, 1);
            return;
        case "beatloop2":
            if (deck) void engine.beatloop(deck, 2);
            return;
        case "beatloop4":
            if (deck) void engine.beatloop(deck, 4);
            return;
        case "beatloop8":
            if (deck) void engine.beatloop(deck, 8);
            return;
        case "hotcue1":
        case "hotcue2":
        case "hotcue3":
        case "hotcue4":
        case "hotcue5":
        case "hotcue6":
        case "hotcue7":
        case "hotcue8": {
            if (!deck) return;
            const slot = Number(m.action.slice("hotcue".length)) - 1;
            void engine.jumpHotCue(deck, slot);
            return;
        }
        case "headphone-cue":
            if (deck) void engine.setCue(deck, true);
            return;
        default:
            return;
    }
}

/** Continuous axis actions. `norm` is 0..1; scaling mirrors MIDI map_to_command. */
function dispatchAxis(m: HidMapping, norm: number): void {
    const deck = m.deck;
    switch (m.action) {
        case "volume-fader":
            if (deck) void engine.setVolume(deck, norm);
            return;
        case "tempo-slider":
            if (deck) void engine.setTempo(deck, 0.5 + norm); // 0.5..1.5
            return;
        case "filter":
            if (deck) void engine.setFilter(deck, norm * 2 - 1); // -1..1
            return;
        case "eq-hi":
            if (deck) void engine.setEq(deck, "high", norm * 32 - 26);
            return;
        case "eq-mid":
            if (deck) void engine.setEq(deck, "mid", norm * 32 - 26);
            return;
        case "eq-low":
            if (deck) void engine.setEq(deck, "low", norm * 32 - 26);
            return;
        case "crossfader":
            void engine.setCrossfader(norm * 2 - 1);
            return;
        case "master-volume":
            void engine.setMasterVolume(norm * 1.5);
            return;
        default:
            return;
    }
}

/** Diff two reports to find the most significant control that changed. */
function detectChange(bytes: number[], prev: number[]): HidLearnCandidate | null {
    const len = Math.max(bytes.length, prev.length);
    let best: HidLearnCandidate | null = null;
    let bestDelta = 0;
    for (let i = 0; i < len; i++) {
        const now = bytes[i] ?? 0;
        const before = prev[i] ?? 0;
        if (now === before) continue;
        const changedBits = now & ~before; // bits that turned ON
        if (changedBits !== 0 && (now === 1 || now === 0 || isSingleBit(changedBits))) {
            // Looks like a button: a single bit went high.
            return { byteIndex: i, mask: changedBits & -changedBits, type: "button", value: now };
        }
        const delta = Math.abs(now - before);
        if (delta > bestDelta) {
            bestDelta = delta;
            best = { byteIndex: i, mask: 0xff, type: "axis", value: now };
        }
    }
    return best;
}

function isSingleBit(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
}

interface HidStore {
    preset: HidPreset;
    /** True while the user is capturing a control to bind. */
    learning: boolean;
    /** The last control the learn pass detected (for the bind editor). */
    candidate: HidLearnCandidate | null;
    /** The most recent raw report (debug + edge detection). */
    lastReport: number[] | null;
    setLearning: (on: boolean) => void;
    setPreset: (preset: HidPreset) => void;
    upsert: (mapping: HidMapping) => void;
    remove: (index: number) => void;
    /** Feed one raw HID report (called from the App's hid://input subscriber). */
    onReport: (e: HidInputEvent) => void;
}

export const useHidStore = create<HidStore>((set, get) => ({
    preset: loadPreset(),
    learning: false,
    candidate: null,
    lastReport: null,
    setLearning: (on) => set({ learning: on, candidate: on ? null : get().candidate }),
    setPreset: (preset) => {
        persist(preset);
        set({ preset });
    },
    upsert: (mapping) => {
        const next = upsertHidMapping(get().preset, mapping);
        persist(next);
        set({ preset: next });
    },
    remove: (index) => {
        const next = removeHidMapping(get().preset, index);
        persist(next);
        set({ preset: next });
    },
    onReport: (e) => {
        const bytes = e.bytes;
        const prev = get().lastReport;
        if (get().learning) {
            if (prev) {
                const cand = detectChange(bytes, prev);
                if (cand) set({ candidate: cand });
            }
        } else {
            for (const m of get().preset.mappings) applyMapping(m, bytes, prev);
        }
        set({ lastReport: bytes });
    },
}));
