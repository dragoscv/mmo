"use client";

/**
 * Controller Color Presets
 *
 * Each preset defines colors for every "role" on a DJ controller (play LED,
 * hot cue pad, pad-mode buttons, etc.). Drivers translate these abstract
 * hex colors into device-specific MIDI velocities/SysEx payloads.
 *
 * Most non-RGB controllers (DDJ-FLX4, DDJ-400) treat the color as a
 * brightness/on-off hint. RGB controllers (DDJ-1000, DDJ-SR2, Traktor S4)
 * map each color via a vendor-specific velocity table.
 */

export type ColorRole =
    | "play"
    | "cue"
    | "sync"
    | "loop"
    | "loopActive"
    | "headphoneCue"
    | "padModeHotcue"
    | "padModeBeatloop"
    | "padModeBeatjump"
    | "padModeSampler"
    | "hotcueEmpty"
    | "hotcueSet"
    | "hotcue1"
    | "hotcue2"
    | "hotcue3"
    | "hotcue4"
    | "hotcue5"
    | "hotcue6"
    | "hotcue7"
    | "hotcue8"
    | "beatFx"
    | "beatFxActive"
    | "shift"
    | "load"
    | "browse";

export interface ColorPreset {
    /** Stable identifier (slug) */
    id: string;
    /** Human-readable name */
    name: string;
    /** Optional category */
    category?: "default" | "club" | "warm" | "cold" | "neon" | "vintage" | "monochrome" | "custom";
    /** One-line description shown in the UI */
    description: string;
    /** Hex (#RRGGBB) per role. Missing roles fall back to defaults. */
    colors: Partial<Record<ColorRole, string>>;
    /** Global brightness multiplier (0..1). Drivers may use to scale velocities. */
    brightness?: number;
    /** Whether this preset ships built-in (vs user-created). */
    builtin?: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────

export const DEFAULT_COLORS: Record<ColorRole, string> = {
    play: "#22c55e",            // green
    cue: "#f97316",             // orange
    sync: "#06b6d4",            // cyan
    loop: "#fbbf24",            // amber
    loopActive: "#fde047",      // bright yellow
    headphoneCue: "#a855f7",    // violet
    padModeHotcue: "#f97316",   // orange
    padModeBeatloop: "#fbbf24", // amber
    padModeBeatjump: "#10b981", // emerald
    padModeSampler: "#ec4899",  // pink
    hotcueEmpty: "#1f2937",     // very dim
    hotcueSet: "#f97316",       // orange (Pioneer default)
    hotcue1: "#ef4444",
    hotcue2: "#f97316",
    hotcue3: "#fbbf24",
    hotcue4: "#22c55e",
    hotcue5: "#06b6d4",
    hotcue6: "#3b82f6",
    hotcue7: "#a855f7",
    hotcue8: "#ec4899",
    beatFx: "#3b82f6",
    beatFxActive: "#06b6d4",
    shift: "#ffffff",
    load: "#22c55e",
    browse: "#ffffff",
};

// ─── Built-in Presets (10) ───────────────────────────────────────────────

export const BUILTIN_COLOR_PRESETS: ColorPreset[] = [
    {
        id: "rekordbox-classic",
        name: "Rekordbox Classic",
        category: "default",
        description: "Pioneer's stock palette — orange cues, white play, classic warmth.",
        builtin: true,
        brightness: 1,
        colors: { ...DEFAULT_COLORS },
    },
    {
        id: "serato-vivid",
        name: "Serato Vivid",
        category: "club",
        description: "Bright saturated palette inspired by Serato DJ Pro performance pads.",
        builtin: true,
        brightness: 1,
        colors: {
            ...DEFAULT_COLORS,
            play: "#22d3ee",
            cue: "#f472b6",
            sync: "#a78bfa",
            loop: "#fde047",
            hotcue1: "#ff3b30",
            hotcue2: "#ff9500",
            hotcue3: "#ffcc00",
            hotcue4: "#34c759",
            hotcue5: "#00c7be",
            hotcue6: "#5ac8fa",
            hotcue7: "#af52de",
            hotcue8: "#ff2d92",
        },
    },
    {
        id: "traktor-spectrum",
        name: "Traktor Spectrum",
        category: "club",
        description: "Native Instruments rainbow inspired by Traktor F1 / S-series remix decks.",
        builtin: true,
        brightness: 1,
        colors: {
            ...DEFAULT_COLORS,
            play: "#00e5a0",
            cue: "#ff5500",
            sync: "#ff00aa",
            loop: "#aaff00",
            padModeHotcue: "#ff5500",
            padModeBeatloop: "#00aaff",
            padModeBeatjump: "#aaff00",
            padModeSampler: "#ff00aa",
            hotcue1: "#ff0055",
            hotcue2: "#ff5500",
            hotcue3: "#ffaa00",
            hotcue4: "#aaff00",
            hotcue5: "#00ffaa",
            hotcue6: "#00aaff",
            hotcue7: "#5500ff",
            hotcue8: "#ff00aa",
        },
    },
    {
        id: "neon-night",
        name: "Neon Night",
        category: "neon",
        description: "Cyberpunk neon: hot pinks, electric blues, acid greens.",
        builtin: true,
        brightness: 1,
        colors: {
            ...DEFAULT_COLORS,
            play: "#39ff14",
            cue: "#ff1493",
            sync: "#00ffff",
            loop: "#ffff00",
            headphoneCue: "#ff00ff",
            padModeHotcue: "#ff1493",
            padModeBeatloop: "#00ffff",
            padModeBeatjump: "#39ff14",
            padModeSampler: "#ff00ff",
            hotcueSet: "#ff1493",
            hotcue1: "#ff1493",
            hotcue2: "#ff5e00",
            hotcue3: "#ffe600",
            hotcue4: "#39ff14",
            hotcue5: "#00ffff",
            hotcue6: "#1e90ff",
            hotcue7: "#ad00ff",
            hotcue8: "#ff00ff",
        },
    },
    {
        id: "warm-amber",
        name: "Warm Amber",
        category: "warm",
        description: "Mellow ambers and reds — easy on the eyes during long sets.",
        builtin: true,
        brightness: 0.9,
        colors: {
            ...DEFAULT_COLORS,
            play: "#fbbf24",
            cue: "#f97316",
            sync: "#fcd34d",
            loop: "#fb923c",
            headphoneCue: "#dc2626",
            padModeHotcue: "#f97316",
            padModeBeatloop: "#fbbf24",
            padModeBeatjump: "#ea580c",
            padModeSampler: "#dc2626",
            hotcueSet: "#fb923c",
            hotcue1: "#dc2626",
            hotcue2: "#ea580c",
            hotcue3: "#f97316",
            hotcue4: "#fb923c",
            hotcue5: "#fbbf24",
            hotcue6: "#facc15",
            hotcue7: "#eab308",
            hotcue8: "#ca8a04",
        },
    },
    {
        id: "cold-ice",
        name: "Cold Ice",
        category: "cold",
        description: "Crystalline blues and cyans — minimal, focused, peak-time techno.",
        builtin: true,
        brightness: 1,
        colors: {
            ...DEFAULT_COLORS,
            play: "#67e8f9",
            cue: "#38bdf8",
            sync: "#0ea5e9",
            loop: "#a5f3fc",
            headphoneCue: "#818cf8",
            padModeHotcue: "#38bdf8",
            padModeBeatloop: "#06b6d4",
            padModeBeatjump: "#3b82f6",
            padModeSampler: "#6366f1",
            hotcueSet: "#0ea5e9",
            hotcue1: "#a5f3fc",
            hotcue2: "#67e8f9",
            hotcue3: "#22d3ee",
            hotcue4: "#06b6d4",
            hotcue5: "#0ea5e9",
            hotcue6: "#3b82f6",
            hotcue7: "#6366f1",
            hotcue8: "#8b5cf6",
        },
    },
    {
        id: "vintage-vinyl",
        name: "Vintage Vinyl",
        category: "vintage",
        description: "Sepia-toned, low-saturation — the colour of well-loved 12-inches.",
        builtin: true,
        brightness: 0.75,
        colors: {
            ...DEFAULT_COLORS,
            play: "#a3a380",
            cue: "#bc6c25",
            sync: "#d4a373",
            loop: "#dda15e",
            headphoneCue: "#606c38",
            padModeHotcue: "#bc6c25",
            padModeBeatloop: "#dda15e",
            padModeBeatjump: "#606c38",
            padModeSampler: "#283618",
            hotcueSet: "#bc6c25",
            hotcue1: "#9c2a2a",
            hotcue2: "#bc6c25",
            hotcue3: "#dda15e",
            hotcue4: "#606c38",
            hotcue5: "#283618",
            hotcue6: "#3a5a40",
            hotcue7: "#588157",
            hotcue8: "#a3b18a",
        },
    },
    {
        id: "monochrome-white",
        name: "Monochrome White",
        category: "monochrome",
        description: "Pure white only — minimalist, distraction-free.",
        builtin: true,
        brightness: 0.85,
        colors: {
            ...DEFAULT_COLORS,
            play: "#ffffff",
            cue: "#ffffff",
            sync: "#ffffff",
            loop: "#ffffff",
            loopActive: "#ffffff",
            headphoneCue: "#ffffff",
            padModeHotcue: "#ffffff",
            padModeBeatloop: "#ffffff",
            padModeBeatjump: "#ffffff",
            padModeSampler: "#ffffff",
            hotcueEmpty: "#000000",
            hotcueSet: "#ffffff",
            hotcue1: "#ffffff",
            hotcue2: "#ffffff",
            hotcue3: "#ffffff",
            hotcue4: "#ffffff",
            hotcue5: "#ffffff",
            hotcue6: "#ffffff",
            hotcue7: "#ffffff",
            hotcue8: "#ffffff",
            beatFx: "#ffffff",
            beatFxActive: "#ffffff",
            shift: "#ffffff",
            load: "#ffffff",
            browse: "#ffffff",
        },
    },
    {
        id: "pride",
        name: "Pride",
        category: "club",
        description: "Rainbow flag across the hot cue row — load, lock in, dance.",
        builtin: true,
        brightness: 1,
        colors: {
            ...DEFAULT_COLORS,
            hotcue1: "#e40303",
            hotcue2: "#ff8c00",
            hotcue3: "#ffed00",
            hotcue4: "#008026",
            hotcue5: "#004dff",
            hotcue6: "#750787",
            hotcue7: "#ff69b4",
            hotcue8: "#ffffff",
            padModeHotcue: "#e40303",
            padModeBeatloop: "#ffed00",
            padModeBeatjump: "#008026",
            padModeSampler: "#750787",
        },
    },
    {
        id: "festival",
        name: "Festival",
        category: "club",
        description: "Saturated festival LED-wall palette — high contrast, made for video.",
        builtin: true,
        brightness: 1,
        colors: {
            ...DEFAULT_COLORS,
            play: "#10b981",
            cue: "#f43f5e",
            sync: "#06b6d4",
            loop: "#fde047",
            loopActive: "#facc15",
            headphoneCue: "#a855f7",
            padModeHotcue: "#f43f5e",
            padModeBeatloop: "#fde047",
            padModeBeatjump: "#10b981",
            padModeSampler: "#a855f7",
            hotcueSet: "#f43f5e",
            hotcue1: "#f43f5e",
            hotcue2: "#fb923c",
            hotcue3: "#fde047",
            hotcue4: "#10b981",
            hotcue5: "#06b6d4",
            hotcue6: "#3b82f6",
            hotcue7: "#a855f7",
            hotcue8: "#ec4899",
        },
    },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

export function getPresetById(id: string): ColorPreset | null {
    return BUILTIN_COLOR_PRESETS.find(p => p.id === id) ?? null;
}

export function colorForRole(preset: ColorPreset, role: ColorRole): string {
    return preset.colors[role] ?? DEFAULT_COLORS[role];
}

/** Parse "#RRGGBB" → {r,g,b} (0..255). Returns black on parse failure. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Compute perceived brightness (0..1) of a hex color (Rec. 601). */
export function colorBrightness(hex: string): number {
    const { r, g, b } = hexToRgb(hex);
    return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
}

/**
 * Pick the closest color from a vendor velocity table for non-RGB hot cue
 * pads. Returns the velocity that produces the visually nearest color.
 */
export function nearestVelocity(
    target: string,
    table: { velocity: number; hex: string }[],
): number {
    if (table.length === 0) return 0;
    const t = hexToRgb(target);
    let best = table[0];
    let bestDist = Number.POSITIVE_INFINITY;
    for (const entry of table) {
        const c = hexToRgb(entry.hex);
        const d = (c.r - t.r) ** 2 + (c.g - t.g) ** 2 + (c.b - t.b) ** 2;
        if (d < bestDist) {
            bestDist = d;
            best = entry;
        }
    }
    return best.velocity;
}
