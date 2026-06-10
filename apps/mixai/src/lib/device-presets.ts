/**
 * Built-in controller presets — "MIDI for all DJ console brands".
 *
 * Each entry is a ready-to-apply {@link MidiPreset} that the user can pick from
 * the Settings → MIDI panel and then fine-tune with the learn→bind editor. The
 * DDJ-FLX4 layout mirrors the native Rust default (`midi.rs::ddj_flx4_preset`);
 * the others are sensible community-style defaults for popular 2-deck
 * controllers using the standard Note-On / CC channel convention (deck A on
 * channel 1, deck B on channel 2). They are starting points, not exhaustive
 * device maps — anything that's slightly off is one MIDI-Learn away from fixed.
 */

import type { MidiAction, MidiMapping, MidiPreset } from "@/bridge/types";

/** Per-deck status bytes + control numbers used to synthesize a preset. */
interface DeviceLayout {
    name: string;
    /** Note-On status byte per deck (e.g. 0x90 = ch1, 0x91 = ch2). */
    noteStatus: [number, number];
    /** CC status byte per deck. */
    ccStatus: [number, number];
    /** Note status byte for the 8 performance pads, per deck. */
    padStatus: [number, number];
    /** Note numbers for transport/loop buttons (shared across decks). */
    notes: Partial<Record<MidiAction, number>>;
    /** CC numbers for continuous controls (shared across decks). */
    ccs: Partial<Record<MidiAction, number>>;
    /** First pad note number; pads are contiguous from here (hotcue 1..8). */
    padBase: number;
    /** Master/global controls: [action, status, midino]. */
    master: [MidiAction, number, number][];
}

const HOTCUES: MidiAction[] = [
    "hotcue1",
    "hotcue2",
    "hotcue3",
    "hotcue4",
    "hotcue5",
    "hotcue6",
    "hotcue7",
    "hotcue8",
];

/** Build a two-deck preset from a compact layout description. */
function build(layout: DeviceLayout): MidiPreset {
    const decks: ("a" | "b")[] = ["a", "b"];
    const mappings: MidiMapping[] = [];

    decks.forEach((deck, i) => {
        const noteSt = layout.noteStatus[i]!;
        const ccSt = layout.ccStatus[i]!;
        const padSt = layout.padStatus[i]!;

        for (const [action, midino] of Object.entries(layout.notes)) {
            mappings.push({
                status: noteSt,
                midino: midino!,
                action: action as MidiAction,
                deck,
                type: "note",
            });
        }
        for (const [action, midino] of Object.entries(layout.ccs)) {
            mappings.push({
                status: ccSt,
                midino: midino!,
                action: action as MidiAction,
                deck,
                type: "cc",
            });
        }
        HOTCUES.forEach((action, p) => {
            mappings.push({ status: padSt, midino: layout.padBase + p, action, deck, type: "note" });
        });
    });

    for (const [action, status, midino] of layout.master) {
        mappings.push({ status, midino, action, deck: null, type: "cc" });
    }

    return { name: layout.name, mappings };
}

/** Pioneer DDJ-FLX4 — matches the native default exactly. */
const ddjFlx4 = build({
    name: "Pioneer DDJ-FLX4",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x97, 0x99],
    notes: {
        play: 0x0b,
        cue: 0x0c,
        sync: 0x58,
        shift: 0x3f,
        "headphone-cue": 0x54,
        "loop-in": 0x10,
        "loop-out": 0x11,
        reloop: 0x4d,
        "loop-halve": 0x51,
        "loop-double": 0x53,
    },
    ccs: {
        "tempo-slider": 0x00,
        "eq-hi": 0x07,
        "eq-mid": 0x0b,
        "eq-low": 0x0f,
        "volume-fader": 0x13,
        filter: 0x18,
    },
    padBase: 0x00,
    master: [
        ["crossfader", 0xb6, 0x1f],
        ["master-volume", 0xb6, 0x09],
    ],
});

/** Numark Mixtrack family — common Serato-style layout. */
const numarkMixtrack = build({
    name: "Numark Mixtrack Pro",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x94, 0x95],
    notes: {
        play: 0x00,
        cue: 0x01,
        sync: 0x02,
        shift: 0x32,
        "headphone-cue": 0x1b,
        "loop-in": 0x38,
        "loop-out": 0x39,
        reloop: 0x3a,
        "loop-halve": 0x34,
        "loop-double": 0x35,
    },
    ccs: {
        "tempo-slider": 0x09,
        "eq-hi": 0x0b,
        "eq-mid": 0x0c,
        "eq-low": 0x0d,
        "volume-fader": 0x16,
        filter: 0x1a,
    },
    padBase: 0x14,
    master: [
        ["crossfader", 0xb0, 0x08],
        ["master-volume", 0xb0, 0x17],
    ],
});

/** Native Instruments Traktor Kontrol S2 style. */
const traktorS2 = build({
    name: "Traktor Kontrol S2",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x92, 0x93],
    notes: {
        play: 0x14,
        cue: 0x15,
        sync: 0x16,
        shift: 0x2f,
        "headphone-cue": 0x17,
        "loop-in": 0x26,
        "loop-out": 0x27,
        reloop: 0x28,
        "loop-halve": 0x29,
        "loop-double": 0x2a,
    },
    ccs: {
        "tempo-slider": 0x04,
        "eq-hi": 0x05,
        "eq-mid": 0x06,
        "eq-low": 0x07,
        "volume-fader": 0x08,
        filter: 0x09,
    },
    padBase: 0x30,
    master: [
        ["crossfader", 0xb0, 0x0f],
        ["master-volume", 0xb0, 0x0a],
    ],
});

/** Hercules DJControl Inpulse / Starlight family. */
const herculesInpulse = build({
    name: "Hercules DJControl Inpulse",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x96, 0x97],
    notes: {
        play: 0x07,
        cue: 0x06,
        sync: 0x05,
        shift: 0x04,
        "headphone-cue": 0x0c,
        "loop-in": 0x38,
        "loop-out": 0x39,
        reloop: 0x3a,
        "loop-halve": 0x12,
        "loop-double": 0x13,
    },
    ccs: {
        "tempo-slider": 0x00,
        "eq-hi": 0x02,
        "eq-mid": 0x03,
        "eq-low": 0x04,
        "volume-fader": 0x01,
        filter: 0x05,
    },
    padBase: 0x10,
    master: [
        ["crossfader", 0xb0, 0x33],
        ["master-volume", 0xb0, 0x0e],
    ],
});

/** Generic 2-deck MIDI controller — standard CC/Note layout. */
const generic = build({
    name: "Generic 2-deck MIDI",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x90, 0x91],
    notes: {
        play: 0x01,
        cue: 0x02,
        sync: 0x03,
        shift: 0x04,
        "headphone-cue": 0x05,
        "loop-in": 0x06,
        "loop-out": 0x07,
        reloop: 0x08,
        "loop-halve": 0x09,
        "loop-double": 0x0a,
    },
    ccs: {
        "tempo-slider": 0x01,
        "eq-hi": 0x02,
        "eq-mid": 0x03,
        "eq-low": 0x04,
        "volume-fader": 0x05,
        filter: 0x06,
    },
    padBase: 0x20,
    master: [
        ["crossfader", 0xb0, 0x07],
        ["master-volume", 0xb0, 0x08],
    ],
});

/** Pioneer DDJ-400 — the rekordbox starter standard. */
const ddj400 = build({
    name: "Pioneer DDJ-400",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x97, 0x99],
    notes: {
        play: 0x0b,
        cue: 0x0c,
        sync: 0x58,
        shift: 0x3f,
        "headphone-cue": 0x54,
        "loop-in": 0x10,
        "loop-out": 0x11,
        reloop: 0x4d,
        "loop-halve": 0x12,
        "loop-double": 0x13,
    },
    ccs: {
        "tempo-slider": 0x00,
        "eq-hi": 0x07,
        "eq-mid": 0x0b,
        "eq-low": 0x0f,
        "volume-fader": 0x13,
        filter: 0x18,
    },
    padBase: 0x00,
    master: [
        ["crossfader", 0xb6, 0x1f],
        ["master-volume", 0xb6, 0x09],
    ],
});

/** Pioneer DDJ-SB3 / SB2 — Serato two-channel family. */
const ddjSb3 = build({
    name: "Pioneer DDJ-SB3",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x97, 0x99],
    notes: {
        play: 0x0b,
        cue: 0x0c,
        sync: 0x58,
        shift: 0x3f,
        "headphone-cue": 0x54,
        "loop-in": 0x10,
        "loop-out": 0x11,
        reloop: 0x4d,
        "loop-halve": 0x4a,
        "loop-double": 0x4c,
    },
    ccs: {
        "tempo-slider": 0x00,
        "eq-hi": 0x07,
        "eq-mid": 0x0b,
        "eq-low": 0x0f,
        "volume-fader": 0x13,
        filter: 0x18,
    },
    padBase: 0x00,
    master: [
        ["crossfader", 0xb6, 0x1f],
        ["master-volume", 0xb6, 0x09],
    ],
});

/** Denon DJ MC7000 — pro 4-deck (deck A/B layer). */
const denonMc7000 = build({
    name: "Denon DJ MC7000",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x94, 0x95],
    notes: {
        play: 0x00,
        cue: 0x01,
        sync: 0x02,
        shift: 0x03,
        "headphone-cue": 0x04,
        "loop-in": 0x14,
        "loop-out": 0x15,
        reloop: 0x16,
        "loop-halve": 0x17,
        "loop-double": 0x18,
    },
    ccs: {
        "tempo-slider": 0x09,
        "eq-hi": 0x0a,
        "eq-mid": 0x0b,
        "eq-low": 0x0c,
        "volume-fader": 0x07,
        filter: 0x0d,
    },
    padBase: 0x20,
    master: [
        ["crossfader", 0xb0, 0x08],
        ["master-volume", 0xb0, 0x0e],
    ],
});

/** Roland DJ-202 — Serato TR-S family. */
const rolandDj202 = build({
    name: "Roland DJ-202",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x96, 0x97],
    notes: {
        play: 0x6b,
        cue: 0x6c,
        sync: 0x69,
        shift: 0x60,
        "headphone-cue": 0x67,
        "loop-in": 0x38,
        "loop-out": 0x39,
        reloop: 0x3a,
        "loop-halve": 0x3b,
        "loop-double": 0x3c,
    },
    ccs: {
        "tempo-slider": 0x00,
        "eq-hi": 0x07,
        "eq-mid": 0x08,
        "eq-low": 0x09,
        "volume-fader": 0x06,
        filter: 0x0a,
    },
    padBase: 0x00,
    master: [
        ["crossfader", 0xb0, 0x1f],
        ["master-volume", 0xb0, 0x0e],
    ],
});

/** Native Instruments Traktor Kontrol S4 MK3. */
const traktorS4 = build({
    name: "Traktor Kontrol S4 MK3",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x92, 0x93],
    notes: {
        play: 0x14,
        cue: 0x15,
        sync: 0x16,
        shift: 0x2f,
        "headphone-cue": 0x17,
        "loop-in": 0x26,
        "loop-out": 0x27,
        reloop: 0x28,
        "loop-halve": 0x29,
        "loop-double": 0x2a,
    },
    ccs: {
        "tempo-slider": 0x04,
        "eq-hi": 0x05,
        "eq-mid": 0x06,
        "eq-low": 0x07,
        "volume-fader": 0x08,
        filter: 0x09,
    },
    padBase: 0x30,
    master: [
        ["crossfader", 0xb0, 0x0f],
        ["master-volume", 0xb0, 0x0a],
    ],
});

/** Reloop Beatmix / Ready family. */
const reloopBeatmix = build({
    name: "Reloop Beatmix",
    noteStatus: [0x90, 0x91],
    ccStatus: [0xb0, 0xb1],
    padStatus: [0x94, 0x95],
    notes: {
        play: 0x00,
        cue: 0x01,
        sync: 0x02,
        shift: 0x03,
        "headphone-cue": 0x04,
        "loop-in": 0x05,
        "loop-out": 0x06,
        reloop: 0x07,
        "loop-halve": 0x08,
        "loop-double": 0x09,
    },
    ccs: {
        "tempo-slider": 0x00,
        "eq-hi": 0x01,
        "eq-mid": 0x02,
        "eq-low": 0x03,
        "volume-fader": 0x04,
        filter: 0x05,
    },
    padBase: 0x10,
    master: [
        ["crossfader", 0xb0, 0x06],
        ["master-volume", 0xb0, 0x07],
    ],
});

/** All built-in presets, in picker order. */
export const DEVICE_PRESETS: readonly MidiPreset[] = [
    ddjFlx4,
    ddj400,
    ddjSb3,
    numarkMixtrack,
    traktorS2,
    traktorS4,
    herculesInpulse,
    denonMc7000,
    rolandDj202,
    reloopBeatmix,
    generic,
];
