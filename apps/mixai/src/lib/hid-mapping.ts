/**
 * HID input mapping — turns raw HID input reports into engine actions.
 *
 * Unlike MIDI (where each control is addressed by a status+number pair carried
 * in the message), HID input reports are **positional**: a fader's value lives
 * at a fixed byte offset in the report, a pad's pressed state is a bit in some
 * byte. So an HID binding addresses a control by `byteIndex` + an optional
 * `mask` (for buttons) and reads the value from that position.
 *
 * This is the frontend mapping layer that sits on top of the native
 * `hid://input` raw-report stream shipped in the HID foundation (0.1.26). It is
 * deliberately frontend-only and data-driven (same philosophy as the MIDI
 * preset model) so community mappings can be authored, exported, and shared
 * without touching Rust.
 */

import type { DeckId, MidiAction } from "@/bridge/types";
import { ALL_ACTIONS, actionLabel } from "@/lib/midi-preset";

/** HID control kinds. Buttons report a bit; axes report a byte value. */
export type HidControlType = "button" | "axis";

/** Bindable actions reuse the MIDI action union (same engine surface). */
export type HidAction = MidiAction;

export interface HidMapping {
    /** Byte offset of this control within the input report. */
    byteIndex: number;
    /**
     * For buttons: the bitmask within that byte that is set when pressed.
     * Ignored for axes (the whole byte is the value, 0..255).
     */
    mask: number;
    type: HidControlType;
    action: HidAction;
    /** Target deck ("a".."d") or null for master/global controls. */
    deck: DeckId | null;
}

/** States a controller LED can reflect back to the user. */
export type HidFeedbackState = "play" | "cue" | "sync" | "loop" | "onair";

/**
 * One LED/feedback mapping: when `state` is active for `deck`, write `onValue`
 * at `byteIndex` of the device's output report (else `offValue`). Output report
 * layouts are device-specific, so this is data-driven like the input mappings.
 */
export interface HidFeedback {
    state: HidFeedbackState;
    deck: DeckId | null;
    byteIndex: number;
    onValue: number;
    offValue: number;
}

export interface HidPreset {
    name: string;
    /** USB vendor id this preset targets (informational; 0 = any). */
    vendorId: number;
    /** USB product id this preset targets (informational; 0 = any). */
    productId: number;
    mappings: HidMapping[];
    /** Optional LED/feedback output mappings (empty when unsupported). */
    feedback?: HidFeedback[];
    /** Report id byte for output reports (0 = unnumbered). */
    outputReportId?: number;
}

/** Reuse the MIDI action ordering/labels — identical engine surface. */
export const ALL_HID_ACTIONS = ALL_ACTIONS;
export const hidActionLabel = actionLabel;

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>(ALL_ACTIONS);
const VALID_DECKS: ReadonlySet<string> = new Set(["a", "b", "c", "d"]);

const EMPTY_PRESET: HidPreset = { name: "Custom HID mapping", vendorId: 0, productId: 0, mappings: [] };

/** A fresh, empty preset for a given device. */
export function emptyHidPreset(vendorId = 0, productId = 0): HidPreset {
    return { name: "Custom HID mapping", vendorId, productId, mappings: [] };
}

/** Read a byte from a report safely (0 when out of range). */
export function reportByte(bytes: readonly number[], index: number): number {
    return bytes[index] ?? 0;
}

/** True when a button binding is currently pressed in this report. */
export function isPressed(bytes: readonly number[], m: HidMapping): boolean {
    return (reportByte(bytes, m.byteIndex) & m.mask) !== 0;
}

/** Clamp/round to an unsigned byte (0..255), or null when not a finite number. */
function byteVal(n: unknown): number | null {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    const i = Math.round(n);
    return i >= 0 && i <= 255 ? i : null;
}

function parseMapping(raw: unknown): HidMapping | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    const byteIndex = byteVal(m.byteIndex);
    if (byteIndex === null) return null;
    const type = m.type === "axis" ? "axis" : m.type === "button" ? "button" : null;
    if (!type) return null;
    // Buttons need a mask; axes default to 0xff (whole byte).
    const mask = byteVal(m.mask) ?? (type === "button" ? null : 0xff);
    if (mask === null) return null;
    if (typeof m.action !== "string" || !VALID_ACTIONS.has(m.action)) return null;
    const deck =
        typeof m.deck === "string" && VALID_DECKS.has(m.deck) ? (m.deck as DeckId) : null;
    return { byteIndex, mask, type, action: m.action as HidAction, deck };
}

/** Serialize a preset to a compact, shareable JSON string. */
export function exportHidPreset(preset: HidPreset): string {
    return JSON.stringify({
        v: 1,
        name: preset.name,
        vendorId: preset.vendorId,
        productId: preset.productId,
        mappings: preset.mappings,
        feedback: preset.feedback ?? [],
        outputReportId: preset.outputReportId ?? 0,
    });
}

/** Parse a shared preset string. Returns null when malformed / empty. */
export function importHidPreset(json: string): HidPreset | null {
    try {
        const data = JSON.parse(json) as {
            name?: unknown;
            vendorId?: unknown;
            productId?: unknown;
            mappings?: unknown;
            feedback?: unknown;
            outputReportId?: unknown;
        };
        const rawList = Array.isArray(data.mappings) ? data.mappings : [];
        const mappings = rawList.map(parseMapping).filter((m): m is HidMapping => m !== null);
        if (mappings.length === 0) return null;
        const name =
            typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Imported HID mapping";
        const vendorId = byteVal16(data.vendorId);
        const productId = byteVal16(data.productId);
        const feedback = Array.isArray(data.feedback)
            ? data.feedback.map(parseFeedback).filter((f): f is HidFeedback => f !== null)
            : [];
        const outputReportId = byteVal(data.outputReportId) ?? 0;
        return { name, vendorId, productId, mappings, feedback, outputReportId };
    } catch {
        return null;
    }
}

const VALID_STATES: ReadonlySet<string> = new Set<HidFeedbackState>([
    "play",
    "cue",
    "sync",
    "loop",
    "onair",
]);

function parseFeedback(raw: unknown): HidFeedback | null {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.state !== "string" || !VALID_STATES.has(f.state)) return null;
    const byteIndex = byteVal(f.byteIndex);
    const onValue = byteVal(f.onValue);
    const offValue = byteVal(f.offValue);
    if (byteIndex === null || onValue === null || offValue === null) return null;
    const deck =
        typeof f.deck === "string" && VALID_DECKS.has(f.deck) ? (f.deck as DeckId) : null;
    return { state: f.state as HidFeedbackState, deck, byteIndex, onValue, offValue };
}

/** Coerce to a 16-bit id (0 fallback). */
function byteVal16(n: unknown): number {
    if (typeof n !== "number" || !Number.isFinite(n)) return 0;
    const i = Math.round(n);
    return i >= 0 && i <= 0xffff ? i : 0;
}

/**
 * Insert or replace a binding. A control is uniquely addressed by
 * (byteIndex, mask) so re-learning the same physical control rebinds it.
 */
export function upsertHidMapping(preset: HidPreset, mapping: HidMapping): HidPreset {
    const idx = preset.mappings.findIndex(
        (m) => m.byteIndex === mapping.byteIndex && m.mask === mapping.mask,
    );
    const mappings =
        idx >= 0
            ? preset.mappings.map((m, i) => (i === idx ? mapping : m))
            : [...preset.mappings, mapping];
    return { ...preset, mappings };
}

/** Remove the binding at `index`, returning a new preset. */
export function removeHidMapping(preset: HidPreset, index: number): HidPreset {
    return { ...preset, mappings: preset.mappings.filter((_, i) => i !== index) };
}

export { EMPTY_PRESET };
