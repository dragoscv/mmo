/**
 * The `style` block of a skin (pack manifest v2, `tokens.json` → `style`): what a skin may
 * change beyond the theme colours. ONE list for the applier (packs/apply-tokens.ts), the skin
 * editor and the docs; the Rust validator (crates/decks-packs) and the SDK validator
 * (sdk/lib/validate.mjs) mirror it key for key — change all three together.
 *
 * Everything is declarative data: a colour (#rrggbb[aa] or oklch()), a bounded number, or an
 * enum. No CSS, no selectors, no URLs.
 */

/** Colour keys → the CSS custom property they set on `:root[data-skin]`. */
export const STYLE_COLORS = {
    well: "--well",
    waveBg: "--wave-bg",
    line: "--line",
    faint: "--fg-faint",
    on: "--on",
    onFg: "--on-fg",
    play: "--skin-play",
    playFg: "--play-fg",
    cue: "--cue-btn",
    alert: "--alert",
    waveLow: "--skin-wave-low",
    waveMid: "--skin-wave-mid",
    waveHigh: "--skin-wave-high",
    waveGrid: "--wave-grid",
    waveDownbeat: "--wave-downbeat",
    wavePlayhead: "--wave-playhead",
    wavePlayheadCap: "--wave-playhead-cap",
    cue1: "--cue-1",
    cue2: "--cue-2",
    cue3: "--cue-3",
    cue4: "--cue-4",
    cue5: "--cue-5",
    cue6: "--cue-6",
    cue7: "--cue-7",
    cue8: "--cue-8",
} as const;
export type StyleColorKey = keyof typeof STYLE_COLORS;

/** Numeric keys: CSS property, allowed range and unit ("" = unitless). */
export const STYLE_SIZES = {
    panelGap: { prop: "--panel-gap", min: 0, max: 16, unit: "" },
    panelRadius: { prop: "--panel-radius", min: 0, max: 16, unit: "px" },
    panelPad: { prop: "--panel-pad", min: 4, max: 16, unit: "px" },
    controlRadius: { prop: "--ctl-radius", min: 0, max: 12, unit: "px" },
    padRadius: { prop: "--pad-radius", min: 0, max: 12, unit: "px" },
    controlHeight: { prop: "--ctl-h", min: 20, max: 32, unit: "px" },
    titlebarHeight: { prop: "--titlebar-h", min: 28, max: 48, unit: "px" },
    wavePlayedAlpha: { prop: "--wave-played-alpha", min: 0.2, max: 1, unit: "" },
} as const;
export type StyleSizeKey = keyof typeof STYLE_SIZES;

export const STYLE_LOOKS = ["signature", "classic"] as const;
/** How the waves panel arranges the decks: one lane per deck, or all decks in one lane. */
export const STYLE_WAVES = ["stacked", "overlay"] as const;
/** A layout id: a built-in one ("pro", "pro-vertical", "classic", …) or one bundled in the same pack. */
const LAYOUT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export interface PackStyle {
    /** Base look the skin builds on (default "signature"). */
    look?: (typeof STYLE_LOOKS)[number];
    /** Show the virtual platter in the decks while this skin is active. */
    platter?: boolean;
    /** Layout to switch to when the user picks the skin (their previous layout comes back with the previous skin). */
    layout?: string;
    /** Waveform arrangement in the waves panel (default "stacked"). */
    waves?: (typeof STYLE_WAVES)[number];
    colors?: Partial<Record<StyleColorKey, string>>;
    sizes?: Partial<Record<StyleSizeKey, number>>;
}

// A number is digits with an optional fraction: a dot needs a digit after it (CSS drops `5.`),
// same rule as `parse_num` in crates/decks-packs and `parseNum` in the Skin SDK.
const NUM = "(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)";
const COLOR_RE = new RegExp(`^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|oklch\\(\\s*${NUM}%?\\s+${NUM}\\s+${NUM}(\\s*\\/\\s*${NUM}%?)?\\s*\\))$`);

export function isStyleColor(v: unknown): v is string {
    return typeof v === "string" && COLOR_RE.test(v.trim());
}

/**
 * Own-key lookup in an allow-list. Never `k in LIST` / `LIST[k]`: both see `Object.prototype`
 * ("toString", "constructor", "__proto__"), which let a colour entry named `toString` validate
 * and reach the skin CSS as a declaration named after a function.
 */
function own<T>(list: Record<string, T>, key: string): T | undefined {
    return Object.hasOwn(list, key) ? list[key] : undefined;
}

/** Problems of a style block (empty = valid). Same checks and order as the Rust validator. */
export function validateStyle(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (typeof raw !== "object" || Array.isArray(raw)) return ["style must be an object"];
    const errs: string[] = [];
    const s = raw as Record<string, unknown>;
    for (const k of Object.keys(s)) if (!["look", "platter", "layout", "waves", "colors", "sizes"].includes(k)) errs.push(`unknown style key '${k}'`);
    if (s.look !== undefined && !(STYLE_LOOKS as readonly unknown[]).includes(s.look)) errs.push("style.look must be signature or classic");
    if (s.platter !== undefined && typeof s.platter !== "boolean") errs.push("style.platter must be true or false");
    if (s.layout !== undefined && (typeof s.layout !== "string" || !LAYOUT_ID_RE.test(s.layout))) errs.push("style.layout must be a layout id (a-z, 0-9, '.', '_', '-'; max 48)");
    if (s.waves !== undefined && !(STYLE_WAVES as readonly unknown[]).includes(s.waves)) errs.push("style.waves must be stacked or overlay");
    if (s.colors !== undefined) {
        if (!s.colors || typeof s.colors !== "object" || Array.isArray(s.colors)) errs.push("style.colors must be an object");
        else
            for (const [k, v] of Object.entries(s.colors as Record<string, unknown>)) {
                if (own(STYLE_COLORS as Record<string, string>, k) === undefined) errs.push(`unknown style colour '${k}'`);
                else if (!isStyleColor(v)) errs.push(`style.colors.${k} must be a valid colour`);
            }
    }
    if (s.sizes !== undefined) {
        if (!s.sizes || typeof s.sizes !== "object" || Array.isArray(s.sizes)) errs.push("style.sizes must be an object");
        else
            for (const [k, v] of Object.entries(s.sizes as Record<string, unknown>)) {
                const spec = own(STYLE_SIZES as Record<string, { min: number; max: number }>, k);
                if (!spec) errs.push(`unknown style size '${k}'`);
                else if (typeof v !== "number" || !Number.isFinite(v) || v < spec.min || v > spec.max) errs.push(`style.sizes.${k} must be a number in ${spec.min}..${spec.max}`);
            }
    }
    return errs;
}

/**
 * CSS declarations for a style block. Invalid entries are dropped one by one (never throws,
 * never emits a value that did not pass the checks), so a bug upstream cannot inject CSS.
 */
export function styleDecls(style: PackStyle | undefined): string[] {
    if (!style || typeof style !== "object") return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(style.colors ?? {})) {
        const prop = own(STYLE_COLORS as Record<string, string>, k);
        if (typeof prop === "string" && isStyleColor(v)) out.push(`${prop}: ${v.trim()};`);
    }
    for (const [k, v] of Object.entries(style.sizes ?? {})) {
        const spec = own(STYLE_SIZES as Record<string, { prop: string; min: number; max: number; unit: string }>, k);
        if (spec && typeof v === "number" && Number.isFinite(v) && v >= spec.min && v <= spec.max) out.push(`${spec.prop}: ${v}${spec.unit};`);
    }
    return out;
}

/** The look a style block asks for ("signature" unless it validly says "classic"). */
export function styleLook(style: PackStyle | undefined): (typeof STYLE_LOOKS)[number] {
    return style?.look === "classic" ? "classic" : "signature";
}

/** The layout a style block asks for, or null (absent or not a valid id). */
export function styleLayout(style: PackStyle | undefined): string | null {
    return typeof style?.layout === "string" && LAYOUT_ID_RE.test(style.layout) ? style.layout : null;
}

/** The waveform arrangement a style block asks for ("stacked" unless it validly says "overlay"). */
export function styleWaves(style: PackStyle | undefined): (typeof STYLE_WAVES)[number] {
    return style?.waves === "overlay" ? "overlay" : "stacked";
}
