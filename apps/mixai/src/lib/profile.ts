/**
 * Profile backup & restore — export the user's entire MIXAI setup (themes,
 * custom themes, deck count, companion/library config, and the active MIDI
 * mapping) to one portable file, and restore it on another machine.
 *
 * This is the local-first precursor to muzicai.ro account sync: the same
 * snapshot shape will later be pushed to / pulled from the signed-in account.
 */

import type { CompanionConfig } from "@/state/companion-store";
import type { CustomTheme } from "@/themes/themes";
import type { MidiPreset } from "@/bridge/types";
import { importPreset } from "@/lib/midi-preset";
import type { HidPreset } from "@/lib/hid-mapping";
import { importHidPreset } from "@/lib/hid-mapping";
import type { ExternalPluginSpec } from "@/plugins/external";
import { parseExternalSpec } from "@/plugins/external";
import type { KeybindOverrides } from "@/state/keybind-store";
import { SHORTCUTS_BY_ID } from "@/lib/shortcuts";

export interface ProfileSnapshot {
    /** Active theme id (built-in `ThemeId` or `custom:<uuid>`). */
    theme: string;
    /** Deck layout. */
    deckCount: 2 | 4;
    /** User-authored themes. */
    customThemes: CustomTheme[];
    /** Companion / muzicai.ro connection config (token included by choice). */
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

/** Validate one custom theme object; returns it typed or null. */
function parseCustomTheme(raw: unknown): CustomTheme | null {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== "string" || !t.id.startsWith("custom:")) return null;
    if (typeof t.name !== "string") return null;
    if (t.motion !== "cinematic" && t.motion !== "subtle" && t.motion !== "minimal") return null;
    if (!t.tokens || typeof t.tokens !== "object") return null;
    const tokens: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.tokens as Record<string, unknown>)) {
        if (typeof v === "string") tokens[k] = v;
    }
    return { id: t.id, name: t.name, motion: t.motion, tokens } as CustomTheme;
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

    if (typeof data.theme === "string") out.theme = data.theme;
    if (isDeckCount(data.deckCount)) out.deckCount = data.deckCount;
    if (Array.isArray(data.customThemes)) {
        out.customThemes = data.customThemes
            .map(parseCustomTheme)
            .filter((t): t is CustomTheme => t !== null);
    }
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
