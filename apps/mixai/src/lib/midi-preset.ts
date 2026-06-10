/**
 * Shareable MIDI mapping presets — serialize the active controller binding so
 * users can export/import community mappings (foundation for the marketplace).
 *
 * The wire format mirrors the Rust `Preset { name, mappings: [{status, midino,
 * action, deck, type}] }`. We keep it compact and versioned so future schema
 * changes can be migrated.
 */

import type { MidiAction, MidiControlType, MidiMapping, MidiPreset } from "@/bridge/types";

/** Every bindable action, in a sensible UI order (also the validation set). */
export const ALL_ACTIONS: readonly MidiAction[] = [
    "play",
    "cue",
    "sync",
    "shift",
    "tempo-slider",
    "volume-fader",
    "crossfader",
    "filter",
    "eq-hi",
    "eq-mid",
    "eq-low",
    "headphone-cue",
    "loop-in",
    "loop-out",
    "reloop",
    "loop-halve",
    "loop-double",
    "beatloop1",
    "beatloop2",
    "beatloop4",
    "beatloop8",
    "hotcue1",
    "hotcue2",
    "hotcue3",
    "hotcue4",
    "hotcue5",
    "hotcue6",
    "hotcue7",
    "hotcue8",
    "master-volume",
];

const VALID_ACTIONS: ReadonlySet<string> = new Set<MidiAction>(ALL_ACTIONS);

const VALID_DECKS: ReadonlySet<string> = new Set(["a", "b", "c", "d"]);

/** Serialize a preset to a compact, shareable JSON string. */
export function exportPreset(preset: MidiPreset): string {
    return JSON.stringify({ v: 1, name: preset.name, mappings: preset.mappings });
}

/** Clamp a value into the 0..127 MIDI byte range (integer). */
function midiByte(n: unknown): number | null {
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    const i = Math.round(n);
    return i >= 0 && i <= 255 ? i : null;
}

/** Validate one raw mapping object, returning a typed mapping or null. */
function parseMapping(raw: unknown): MidiMapping | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    const status = midiByte(m.status);
    const midino = midiByte(m.midino);
    if (status === null || midino === null) return null;
    if (typeof m.action !== "string" || !VALID_ACTIONS.has(m.action)) return null;
    const type = m.type === "cc" ? "cc" : m.type === "note" ? "note" : null;
    if (!type) return null;
    const deck =
        typeof m.deck === "string" && VALID_DECKS.has(m.deck)
            ? (m.deck as MidiMapping["deck"])
            : null;
    return {
        status,
        midino,
        action: m.action as MidiAction,
        deck,
        type: type as MidiControlType,
    };
}

/**
 * Parse a shared preset string. Returns null when malformed or when no valid
 * mappings survive validation.
 */
export function importPreset(json: string): MidiPreset | null {
    try {
        const data = JSON.parse(json) as { name?: unknown; mappings?: unknown };
        const rawList = Array.isArray(data.mappings) ? data.mappings : [];
        const mappings = rawList
            .map(parseMapping)
            .filter((m): m is MidiMapping => m !== null);
        if (mappings.length === 0) return null;
        const name =
            typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Imported mapping";
        return { name, mappings };
    } catch {
        return null;
    }
}

/** Human-friendly label for a MIDI action (for the bindings table). */
export function actionLabel(action: MidiAction): string {
    return action
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/Eq/g, "EQ");
}

/**
 * Infer the control kind from a MIDI status byte. Control-Change messages are
 * 0xB0..0xBF (continuous knobs/faders); everything else we treat as a Note
 * (buttons/pads — Note On 0x90.. / Note Off 0x80..).
 */
export function controlTypeFromStatus(status: number): MidiControlType {
    return (status & 0xf0) === 0xb0 ? "cc" : "note";
}

/**
 * Insert or replace a binding. A control is uniquely addressed by its
 * (status, midino) pair, so re-learning the same physical control rebinds it
 * rather than creating a duplicate. Returns a new preset (immutable).
 */
export function upsertMapping(preset: MidiPreset, mapping: MidiMapping): MidiPreset {
    const idx = preset.mappings.findIndex(
        (m) => m.status === mapping.status && m.midino === mapping.midino,
    );
    const mappings =
        idx >= 0
            ? preset.mappings.map((m, i) => (i === idx ? mapping : m))
            : [...preset.mappings, mapping];
    return { name: preset.name, mappings };
}

/** Remove the binding at `index`, returning a new preset. */
export function removeMapping(preset: MidiPreset, index: number): MidiPreset {
    return { name: preset.name, mappings: preset.mappings.filter((_, i) => i !== index) };
}
