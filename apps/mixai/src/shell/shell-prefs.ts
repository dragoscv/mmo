/**
 * Shell appearance prefs that are not shared theme dimensions: perf HUD,
 * frame-budget governor, beat-reactive accent, touch mode, colour-blind deck
 * palette, onboarding state. Persisted to localStorage `mixai-shell`, part of
 * the settings export ("appearance" section) and applied to <html> as data-*
 * attributes so CSS can react without React re-renders.
 */
import { create } from "zustand";

export const DECK_PALETTES = ["brand", "deuteranopia", "protanopia", "tritanopia", "mono"] as const;
export type DeckPalette = (typeof DECK_PALETTES)[number];

/** Hot cue colours: the look's eight colours, or a colour-blind-safe set (look.css). */
export const CUE_PALETTES = ["default", "safe"] as const;
export type CuePalette = (typeof CUE_PALETTES)[number];

export interface ShellPrefs {
    hud: boolean;
    governor: boolean;
    beatAccent: boolean;
    touch: boolean;
    palette: DeckPalette;
    highContrast: boolean;
    onboarded: boolean;
    /** Booth mode: bigger readouts and stronger contrast (dark booth / daylight). */
    booth: boolean;
    /** Show the virtual platter in the deck (off by default; skins may turn it on). */
    platter: boolean;
    cuePalette: CuePalette;
}

const KEY = "mixai-shell";
export const SHELL_DEFAULTS: ShellPrefs = {
    hud: false,
    governor: true,
    beatAccent: false,
    touch: false,
    palette: "brand",
    highContrast: false,
    onboarded: false,
    booth: false,
    platter: false,
    cuePalette: "default",
};

export function parseShellPrefs(raw: unknown): ShellPrefs {
    const r = raw && typeof raw === "object" ? (raw as Partial<ShellPrefs>) : {};
    const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
    return {
        hud: bool(r.hud, SHELL_DEFAULTS.hud),
        governor: bool(r.governor, SHELL_DEFAULTS.governor),
        beatAccent: bool(r.beatAccent, SHELL_DEFAULTS.beatAccent),
        touch: bool(r.touch, SHELL_DEFAULTS.touch),
        palette: DECK_PALETTES.includes(r.palette as DeckPalette) ? (r.palette as DeckPalette) : SHELL_DEFAULTS.palette,
        highContrast: bool(r.highContrast, SHELL_DEFAULTS.highContrast),
        onboarded: bool(r.onboarded, SHELL_DEFAULTS.onboarded),
        booth: bool(r.booth, SHELL_DEFAULTS.booth),
        platter: bool(r.platter, SHELL_DEFAULTS.platter),
        cuePalette: CUE_PALETTES.includes(r.cuePalette as CuePalette) ? (r.cuePalette as CuePalette) : SHELL_DEFAULTS.cuePalette,
    };
}

function load(): ShellPrefs {
    try {
        return parseShellPrefs(JSON.parse(localStorage.getItem(KEY) ?? "null"));
    } catch {
        return { ...SHELL_DEFAULTS };
    }
}

/** Write the CSS-facing attributes on <html>. */
export function applyShellPrefs(p: ShellPrefs): void {
    if (typeof document === "undefined") return;
    const d = document.documentElement.dataset;
    d.touch = p.touch ? "on" : "off";
    d.deckPalette = p.palette;
    d.contrast = p.highContrast ? "high" : "normal";
    d.beatAccent = p.beatAccent ? "on" : "off";
    d.booth = p.booth ? "on" : "off";
    d.platter = p.platter ? "on" : "off";
    d.cuePalette = p.cuePalette;
}

interface Store extends ShellPrefs {
    set: (patch: Partial<ShellPrefs>) => void;
    restore: (p: unknown) => void;
    snapshot: () => ShellPrefs;
}

export const useShellPrefs = create<Store>((set, get) => {
    const initial = load();
    applyShellPrefs(initial);
    const commit = (next: ShellPrefs) => {
        set(next);
        applyShellPrefs(next);
        try {
            localStorage.setItem(KEY, JSON.stringify(next));
        } catch {
            // storage unavailable
        }
    };
    return {
        ...initial,
        set: (patch) => commit(parseShellPrefs({ ...get().snapshot(), ...patch })),
        restore: (p) => commit(parseShellPrefs(p)),
        snapshot: () => {
            const { hud, governor, beatAccent, touch, palette, highContrast, onboarded, booth, platter, cuePalette } = get();
            return { hud, governor, beatAccent, touch, palette, highContrast, onboarded, booth, platter, cuePalette };
        },
    };
});
