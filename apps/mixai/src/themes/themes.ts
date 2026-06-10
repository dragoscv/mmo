/**
 * MIXAI theming — themeable from day 1.
 *
 * A theme is a flat token map applied as CSS custom properties on <html>.
 * Three shipped themes; users can switch live and (later) share custom ones.
 */

export type ThemeId = "neon-glass" | "studio-metal" | "flat-pro";

export interface Theme {
    /** Built-in `ThemeId` or a `custom:<uuid>` string. */
    id: string;
    name: string;
    /** Motion intensity: scales transition durations & spring energy. */
    motion: "cinematic" | "subtle" | "minimal";
    tokens: Record<string, string>;
}

export const THEMES: Record<ThemeId, Theme> = {
    "neon-glass": {
        id: "neon-glass",
        name: "Neon Glass",
        motion: "cinematic",
        tokens: {
            "--bg": "#070711",
            "--bg-elev": "rgba(255,255,255,0.04)",
            "--bg-elev-2": "rgba(255,255,255,0.07)",
            "--border": "rgba(255,255,255,0.10)",
            "--fg": "#f4f5ff",
            "--fg-dim": "rgba(244,245,255,0.55)",
            "--accent": "#7c5cff",
            "--accent-2": "#19e3ff",
            "--accent-deck-a": "#19e3ff",
            "--accent-deck-b": "#ff4d8d",
            "--good": "#3ddc97",
            "--warn": "#ffb020",
            "--danger": "#ff4d6d",
            "--card-radius": "18px",
            "--blur": "18px",
            "--glow": "0 0 24px",
            "--panel-bg": "rgba(12,12,24,0.55)",
            "--shadow": "0 18px 50px rgba(0,0,0,0.55)",
        },
    },
    "studio-metal": {
        id: "studio-metal",
        name: "Studio Metal",
        motion: "subtle",
        tokens: {
            "--bg": "#1b1d22",
            "--bg-elev": "#23262d",
            "--bg-elev-2": "#2b2f37",
            "--border": "rgba(0,0,0,0.45)",
            "--fg": "#e8eaf0",
            "--fg-dim": "rgba(232,234,240,0.5)",
            "--accent": "#d98a3d",
            "--accent-2": "#8a9bb3",
            "--accent-deck-a": "#d98a3d",
            "--accent-deck-b": "#5fa8d3",
            "--good": "#6fcf97",
            "--warn": "#f2c94c",
            "--danger": "#eb5757",
            "--card-radius": "10px",
            "--blur": "0px",
            "--glow": "0 2px 0",
            "--panel-bg": "linear-gradient(180deg,#2b2f37,#23262d)",
            "--shadow": "inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 20px rgba(0,0,0,0.5)",
        },
    },
    "flat-pro": {
        id: "flat-pro",
        name: "Flat Pro",
        motion: "minimal",
        tokens: {
            "--bg": "#0e0f12",
            "--bg-elev": "#16181d",
            "--bg-elev-2": "#1d2026",
            "--border": "rgba(255,255,255,0.08)",
            "--fg": "#e6e8ec",
            "--fg-dim": "rgba(230,232,236,0.5)",
            "--accent": "#2f80ed",
            "--accent-2": "#27ae60",
            "--accent-deck-a": "#2f80ed",
            "--accent-deck-b": "#eb5757",
            "--good": "#27ae60",
            "--warn": "#f2c94c",
            "--danger": "#eb5757",
            "--card-radius": "6px",
            "--blur": "0px",
            "--glow": "0 0 0",
            "--panel-bg": "#16181d",
            "--shadow": "none",
        },
    },
};

export function applyTheme(id: ThemeId): void {
    applyThemeDef(THEMES[id]);
}

/** Apply any theme object (built-in or custom) to the document root. */
export function applyThemeDef(theme: Theme): void {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.tokens)) {
        root.style.setProperty(key, value);
    }
    root.dataset.theme = theme.id;
    root.dataset.motion = theme.motion;
}

/** Duration helper that respects the active theme's motion profile. */
export function motionDuration(base: number, motion: Theme["motion"]): number {
    switch (motion) {
        case "cinematic":
            return base;
        case "subtle":
            return base * 0.6;
        case "minimal":
            return base * 0.25;
    }
}

// ─── Custom / shareable themes ───────────────────────────────────────────────

/** Marker for user-authored themes (vs the built-in `ThemeId` union). */
export const CUSTOM_THEME_PREFIX = "custom:";

/** A user-authored theme. `id` is namespaced so it never clashes with builtins. */
export interface CustomTheme extends Theme {
    id: `custom:${string}`;
}

export function isCustomThemeId(id: string): id is `custom:${string}` {
    return id.startsWith(CUSTOM_THEME_PREFIX);
}

/**
 * Color tokens a user can edit in the theme editor (paired with a friendly
 * label). Structural tokens (radius/blur/shadow) are derived from the chosen
 * motion profile to keep custom themes coherent and crash-free.
 */
export const EDITABLE_TOKENS: { key: string; label: string }[] = [
    { key: "--bg", label: "Background" },
    { key: "--bg-elev", label: "Surface" },
    { key: "--bg-elev-2", label: "Surface 2" },
    { key: "--fg", label: "Text" },
    { key: "--accent", label: "Accent" },
    { key: "--accent-2", label: "Accent 2" },
    { key: "--accent-deck-a", label: "Deck A" },
    { key: "--accent-deck-b", label: "Deck B" },
    { key: "--good", label: "Good" },
    { key: "--warn", label: "Warn" },
    { key: "--danger", label: "Danger" },
];

/** Structural tokens applied on top of a custom theme's colors, per motion. */
function structuralTokens(motion: Theme["motion"]): Record<string, string> {
    switch (motion) {
        case "cinematic":
            return {
                "--border": "rgba(255,255,255,0.10)",
                "--fg-dim": "rgba(244,245,255,0.55)",
                "--card-radius": "18px",
                "--blur": "18px",
                "--glow": "0 0 24px",
                "--panel-bg": "rgba(12,12,24,0.55)",
                "--shadow": "0 18px 50px rgba(0,0,0,0.55)",
            };
        case "subtle":
            return {
                "--border": "rgba(0,0,0,0.45)",
                "--fg-dim": "rgba(232,234,240,0.5)",
                "--card-radius": "10px",
                "--blur": "0px",
                "--glow": "0 2px 0",
                "--panel-bg": "var(--bg-elev)",
                "--shadow": "inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 20px rgba(0,0,0,0.5)",
            };
        case "minimal":
            return {
                "--border": "rgba(255,255,255,0.08)",
                "--fg-dim": "rgba(230,232,236,0.5)",
                "--card-radius": "6px",
                "--blur": "0px",
                "--glow": "0 0 0",
                "--panel-bg": "var(--bg-elev)",
                "--shadow": "none",
            };
    }
}

/** Build a complete custom theme from editable colors + a motion profile. */
export function makeCustomTheme(
    id: `custom:${string}`,
    name: string,
    motion: Theme["motion"],
    colors: Record<string, string>,
): CustomTheme {
    return { id, name, motion, tokens: { ...colors, ...structuralTokens(motion) } };
}

/** A sensible starting point for a new custom theme (clones Neon Glass colors). */
export function blankCustomTheme(id: `custom:${string}`, name: string): CustomTheme {
    const base = THEMES["neon-glass"].tokens;
    const colors: Record<string, string> = {};
    for (const { key } of EDITABLE_TOKENS) colors[key] = base[key] ?? "#888888";
    return makeCustomTheme(id, name, "cinematic", colors);
}

/** Serialize a custom theme to a compact, shareable JSON string. */
export function exportTheme(theme: CustomTheme): string {
    const colors: Record<string, string> = {};
    for (const { key } of EDITABLE_TOKENS) {
        const v = theme.tokens[key];
        if (v) colors[key] = v;
    }
    return JSON.stringify({ v: 1, name: theme.name, motion: theme.motion, colors });
}

/**
 * Parse a shared theme string back into a CustomTheme. Returns null when the
 * payload is malformed. A fresh id is assigned by the caller's store.
 */
export function importTheme(json: string, id: `custom:${string}`): CustomTheme | null {
    try {
        const data = JSON.parse(json) as {
            name?: unknown;
            motion?: unknown;
            colors?: unknown;
        };
        const motions: Theme["motion"][] = ["cinematic", "subtle", "minimal"];
        const motion = motions.includes(data.motion as Theme["motion"])
            ? (data.motion as Theme["motion"])
            : "cinematic";
        const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Imported";
        const raw = (data.colors ?? {}) as Record<string, unknown>;
        const colors: Record<string, string> = {};
        for (const { key } of EDITABLE_TOKENS) {
            const v = raw[key];
            colors[key] = typeof v === "string" ? v : (THEMES["neon-glass"].tokens[key] ?? "#888888");
        }
        return makeCustomTheme(id, name, motion, colors);
    } catch {
        return null;
    }
}
