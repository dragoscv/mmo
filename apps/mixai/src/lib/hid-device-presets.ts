/**
 * Built-in HID device presets — starting-point mappings for known HID-class
 * DJ gear so users don't have to learn every control by hand.
 *
 * HID reports are *positional*: a control lives at a fixed byte offset, and a
 * button is a bit within a byte. Unlike the MIDI presets (which match documented
 * channel/CC conventions), HID report layouts are proprietary and vary by
 * firmware, so these are **honest scaffolds**: a plausible byte map plus the
 * right vendor/product id and control set. The real value is the structure —
 * any offset that's slightly off is one HID-Learn (0.1.27) away from fixed, and
 * the user can then Share the corrected mapping back to the community.
 *
 * Where a real public layout is well-known (e.g. the Pioneer DDJ HID interface
 * exposes faders as single bytes in the input report), the offsets reflect that;
 * otherwise they follow a consistent, easy-to-relearn convention.
 */

import type { DeckId } from "@/bridge/types";
import type { HidAction, HidMapping, HidPreset } from "@/lib/hid-mapping";

/** Compact description of a two-deck HID layout, expanded by {@link build}. */
interface HidLayout {
    name: string;
    vendorId: number;
    productId: number;
    /** Base byte offset for deck A's controls; deck B is `deckStride` later. */
    deckBase: number;
    /** Bytes between deck A and deck B control blocks. */
    deckStride: number;
    /** Axis controls, as offset-within-deck-block per action. */
    axes: Partial<Record<HidAction, number>>;
    /**
     * Button controls, as [offsetWithinDeckBlock, bitmask] per action. Several
     * buttons commonly share one byte, distinguished by bit.
     */
    buttons: Partial<Record<HidAction, [number, number]>>;
    /** First byte of the 8 performance pads within a deck block (one bit each). */
    padByte: number;
    /** Master/global controls: [action, absoluteByteOffset] (axes). */
    masterAxes: [HidAction, number][];
}

const HOTCUES: HidAction[] = [
    "hotcue1",
    "hotcue2",
    "hotcue3",
    "hotcue4",
    "hotcue5",
    "hotcue6",
    "hotcue7",
    "hotcue8",
];

/** Build a two-deck HID preset from a compact layout description. */
function build(layout: HidLayout): HidPreset {
    const decks: DeckId[] = ["a", "b"];
    const mappings: HidMapping[] = [];

    decks.forEach((deck, i) => {
        const base = layout.deckBase + i * layout.deckStride;

        for (const [action, off] of Object.entries(layout.axes)) {
            mappings.push({
                byteIndex: base + (off as number),
                mask: 0xff,
                type: "axis",
                action: action as HidAction,
                deck,
            });
        }
        for (const [action, spec] of Object.entries(layout.buttons)) {
            const [off, mask] = spec as [number, number];
            mappings.push({
                byteIndex: base + off,
                mask,
                type: "button",
                action: action as HidAction,
                deck,
            });
        }
        // 8 pads: contiguous bits across the pad byte (and the next byte for >8).
        HOTCUES.forEach((action, p) => {
            const byteOffset = layout.padByte + (p >> 3); // 8 bits per byte
            const bit = 1 << (p & 7);
            mappings.push({ byteIndex: base + byteOffset, mask: bit, type: "button", action, deck });
        });
    });

    for (const [action, byteIndex] of layout.masterAxes) {
        mappings.push({ byteIndex, mask: 0xff, type: "axis", action, deck: null });
    }

    return { name: layout.name, vendorId: layout.vendorId, productId: layout.productId, mappings };
}

/**
 * Pioneer DDJ-FLX4 (HID mode). The DDJ HID input report carries continuous
 * controls as single bytes and buttons as bit flags; deck B mirrors deck A a
 * fixed stride later. Offsets here are a coherent scaffold to relearn from.
 */
const ddjFlx4Hid = build({
    name: "Pioneer DDJ-FLX4 (HID)",
    vendorId: 0x2b73,
    productId: 0x003c,
    deckBase: 1,
    deckStride: 16,
    axes: {
        "tempo-slider": 0,
        "eq-hi": 1,
        "eq-mid": 2,
        "eq-low": 3,
        "volume-fader": 4,
        filter: 5,
    },
    buttons: {
        play: [6, 0x01],
        cue: [6, 0x02],
        sync: [6, 0x04],
        "headphone-cue": [6, 0x08],
        "loop-in": [7, 0x01],
        "loop-out": [7, 0x02],
        reloop: [7, 0x04],
        "loop-halve": [7, 0x08],
        "loop-double": [7, 0x10],
    },
    padByte: 8,
    masterAxes: [
        ["crossfader", 33],
        ["master-volume", 34],
    ],
});
// LED feedback scaffold for the FLX4 (play/cue/sync/loop per deck on an output
// report). Output layouts are firmware-specific — these are relearn-from
// starting points, mirroring the input-mapping philosophy.
ddjFlx4Hid.outputReportId = 0;
ddjFlx4Hid.feedback = [
    { state: "play", deck: "a", byteIndex: 1, onValue: 0x01, offValue: 0x00 },
    { state: "cue", deck: "a", byteIndex: 1, onValue: 0x02, offValue: 0x00 },
    { state: "sync", deck: "a", byteIndex: 1, onValue: 0x04, offValue: 0x00 },
    { state: "loop", deck: "a", byteIndex: 1, onValue: 0x08, offValue: 0x00 },
    { state: "play", deck: "b", byteIndex: 2, onValue: 0x01, offValue: 0x00 },
    { state: "cue", deck: "b", byteIndex: 2, onValue: 0x02, offValue: 0x00 },
    { state: "sync", deck: "b", byteIndex: 2, onValue: 0x04, offValue: 0x00 },
    { state: "loop", deck: "b", byteIndex: 2, onValue: 0x08, offValue: 0x00 },
];

/** Pioneer CDJ-3000 (single-deck player; mapped to deck A by default). */
const cdj3000Hid: HidPreset = {
    name: "Pioneer CDJ-3000 (HID)",
    vendorId: 0x08e4,
    productId: 0x0188,
    mappings: [
        { byteIndex: 1, mask: 0x01, type: "button", action: "play", deck: "a" },
        { byteIndex: 1, mask: 0x02, type: "button", action: "cue", deck: "a" },
        { byteIndex: 1, mask: 0x04, type: "button", action: "sync", deck: "a" },
        { byteIndex: 2, mask: 0x01, type: "button", action: "loop-in", deck: "a" },
        { byteIndex: 2, mask: 0x02, type: "button", action: "loop-out", deck: "a" },
        { byteIndex: 2, mask: 0x04, type: "button", action: "reloop", deck: "a" },
        { byteIndex: 3, mask: 0xff, type: "axis", action: "tempo-slider", deck: "a" },
        ...HOTCUES.map((action, p) => ({
            byteIndex: 4 + (p >> 3),
            mask: 1 << (p & 7),
            type: "button" as const,
            action,
            deck: "a" as DeckId,
        })),
    ],
};

/** Pioneer CDJ-2000NXS2 (single-deck player; mapped to deck A by default). */
const cdj2000nxs2Hid: HidPreset = {
    name: "Pioneer CDJ-2000NXS2 (HID)",
    vendorId: 0x08e4,
    productId: 0x017f,
    mappings: [
        { byteIndex: 1, mask: 0x01, type: "button", action: "play", deck: "a" },
        { byteIndex: 1, mask: 0x02, type: "button", action: "cue", deck: "a" },
        { byteIndex: 1, mask: 0x04, type: "button", action: "sync", deck: "a" },
        { byteIndex: 2, mask: 0x01, type: "button", action: "loop-in", deck: "a" },
        { byteIndex: 2, mask: 0x02, type: "button", action: "loop-out", deck: "a" },
        { byteIndex: 2, mask: 0x04, type: "button", action: "reloop", deck: "a" },
        { byteIndex: 3, mask: 0xff, type: "axis", action: "tempo-slider", deck: "a" },
        ...HOTCUES.map((action, p) => ({
            byteIndex: 4 + (p >> 3),
            mask: 1 << (p & 7),
            type: "button" as const,
            action,
            deck: "a" as DeckId,
        })),
    ],
};

/** Pioneer DDJ-1000 (HID mode) — 4-channel rekordbox flagship (A/B layer). */
const ddj1000Hid = build({
    name: "Pioneer DDJ-1000 (HID)",
    vendorId: 0x2b73,
    productId: 0x000f,
    deckBase: 1,
    deckStride: 18,
    axes: {
        "tempo-slider": 0,
        "eq-hi": 1,
        "eq-mid": 2,
        "eq-low": 3,
        "volume-fader": 4,
        filter: 5,
    },
    buttons: {
        play: [6, 0x01],
        cue: [6, 0x02],
        sync: [6, 0x04],
        "headphone-cue": [6, 0x08],
        "loop-in": [7, 0x01],
        "loop-out": [7, 0x02],
        reloop: [7, 0x04],
        "loop-halve": [7, 0x08],
        "loop-double": [7, 0x10],
    },
    padByte: 8,
    masterAxes: [
        ["crossfader", 37],
        ["master-volume", 38],
    ],
});

/** Numark party-mixer style HID layout (generic 2-deck scaffold). */
const numarkHid = build({
    name: "Numark (HID)",
    vendorId: 0x15e4,
    productId: 0x0000,
    deckBase: 1,
    deckStride: 14,
    axes: {
        "tempo-slider": 0,
        "eq-hi": 1,
        "eq-mid": 2,
        "eq-low": 3,
        "volume-fader": 4,
        filter: 5,
    },
    buttons: {
        play: [6, 0x01],
        cue: [6, 0x02],
        sync: [6, 0x04],
        reloop: [7, 0x01],
    },
    padByte: 8,
    masterAxes: [
        ["crossfader", 29],
        ["master-volume", 30],
    ],
});

/** Generic 2-deck HID scaffold — clean, easy-to-relearn byte layout. */
const genericHid = build({
    name: "Generic 2-deck HID",
    vendorId: 0,
    productId: 0,
    deckBase: 1,
    deckStride: 12,
    axes: {
        "volume-fader": 0,
        "tempo-slider": 1,
        "eq-hi": 2,
        "eq-mid": 3,
        "eq-low": 4,
        filter: 5,
    },
    buttons: {
        play: [6, 0x01],
        cue: [6, 0x02],
        sync: [6, 0x04],
        reloop: [6, 0x08],
    },
    padByte: 7,
    masterAxes: [
        ["crossfader", 25],
        ["master-volume", 26],
    ],
});

/** All built-in HID presets, in picker order. */
export const HID_DEVICE_PRESETS: readonly HidPreset[] = [
    ddjFlx4Hid,
    ddj1000Hid,
    cdj3000Hid,
    cdj2000nxs2Hid,
    numarkHid,
    genericHid,
];

/**
 * Find the preset whose vendor/product id matches a connected device, so the UI
 * can suggest it automatically. Returns null when there's no specific match.
 */
export function presetForDevice(vendorId: number, productId: number): HidPreset | null {
    return (
        HID_DEVICE_PRESETS.find(
            (p) => p.vendorId === vendorId && p.productId !== 0 && p.productId === productId,
        ) ??
        HID_DEVICE_PRESETS.find((p) => p.vendorId === vendorId && p.vendorId !== 0) ??
        null
    );
}
