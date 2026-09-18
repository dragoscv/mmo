/**
 * Profile backup & restore — export the user's entire MIXAI setup (appearance
 * prefs, deck count, companion/library config, and the active MIDI mapping) to
 * one portable file, and restore it on another machine.
 *
 * This is the local-first precursor to mixai.ro account sync: the same
 * snapshot shape will later be pushed to / pulled from the signed-in account.
 */

import type { CompanionConfig } from "@/state/companion-store";
import { normalizePrefs, type ThemePrefs } from "@mmo/design-tokens";
import type { MidiPreset } from "@/bridge/types";
import { importPreset } from "@/lib/midi-preset";
import type { HidPreset } from "@/lib/hid-mapping";
import { importHidPreset } from "@/lib/hid-mapping";
import type { ExternalPluginSpec } from "@/plugins/external";
import { parseExternalSpec } from "@/plugins/external";
import type { KeybindOverrides } from "@/state/keybind-store";
import { SHORTCUTS_BY_ID } from "@/lib/shortcuts";

export interface ProfileSnapshot {
    /** Shared appearance prefs (mode / accent / surface / density / …). */
    prefs: ThemePrefs;
    /** Deck layout. */
    deckCount: 2 | 4;
    /** Companion / mixai.ro connection config (token included by choice). */
    companion: CompanionConfig;
    /** Active MIDI controller mapping, when one is loaded. */
    midiPreset: MidiPreset | null;
    /** Active HID controller mapping, when one is loaded. */
    hidPreset: HidPreset | null;
    /** Installed declarative external plugins (specs, not live objects). */
    externalPlugins: ExternalPluginSpec[];
    /** User keyboard-shortcut overrides (stable id → KeyboardEvent.code). */
    keybinds: KeybindOverrides;
}

/** Serialize a profile to a versioned, shareable JSON string. */
export function exportProfile(snap: ProfileSnapshot): string {
    return JSON.stringify({ v: 1, ...snap }, null, 2);
}

function isDeckCount(n: unknown): n is 2 | 4 {
    return n === 2 || n === 4;
}

/**
 * Legacy (v1, pre design-system) profiles carried a skin id instead of prefs.
 * Map it onto a surface preset so an old backup still restores the look.
 */
function legacySkinToPrefs(theme: unknown): Partial<ThemePrefs> | null {
    if (theme === "flat-pro") return { surface: "flat" };
    if (theme === "studio-metal") return { surface: "solid" };
    if (theme === "neon-glass") return { surface: "glass" };
    return null;
}

function parseCompanion(raw: unknown): CompanionConfig | null {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.baseUrl !== "string") return null;
    return {
        baseUrl: c.baseUrl,
        deviceToken: typeof c.deviceToken === "string" ? c.deviceToken : "",
        userId: typeof c.userId === "string" ? c.userId : "",
    };
}

/**
 * Parse a profile backup string. Returns null only when nothing usable can be
 * recovered; individual missing/invalid sections are simply omitted so a
 * partial backup still restores what it can.
 */
export function importProfile(json: string): Partial<ProfileSnapshot> | null {
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(json) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!data || typeof data !== "object") return null;

    const out: Partial<ProfileSnapshot> = {};

    if (data.prefs && typeof data.prefs === "object") {
        out.prefs = normalizePrefs(data.prefs);
    } else {
        const legacy = legacySkinToPrefs(data.theme);
        if (legacy) out.prefs = normalizePrefs(legacy);
    }
    if (isDeckCount(data.deckCount)) out.deckCount = data.deckCount;
    const companion = parseCompanion(data.companion);
    if (companion) out.companion = companion;
    if (data.midiPreset) {
        const preset = importPreset(JSON.stringify(data.midiPreset));
        if (preset) out.midiPreset = preset;
    }
    if (data.hidPreset) {
        const preset = importHidPreset(JSON.stringify(data.hidPreset));
        if (preset) out.hidPreset = preset;
    }
    if (Array.isArray(data.externalPlugins)) {
        out.externalPlugins = data.externalPlugins
            .map((spec) => parseExternalSpec(JSON.stringify(spec)))
            .filter((s): s is ExternalPluginSpec => s !== null);
    }
    if (data.keybinds && typeof data.keybinds === "object" && !Array.isArray(data.keybinds)) {
        const kb: KeybindOverrides = {};
        for (const [k, v] of Object.entries(data.keybinds as Record<string, unknown>)) {
            if (typeof v === "string" && v && SHORTCUTS_BY_ID.has(k)) kb[k] = v;
        }
        if (Object.keys(kb).length > 0) out.keybinds = kb;
    }

    // Nothing recognizable → treat as malformed.
    if (Object.keys(out).length === 0) return null;
    return out;
}
