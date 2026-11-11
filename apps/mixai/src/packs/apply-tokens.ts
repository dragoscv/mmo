/**
 * Turn validated pack tokens into CSS. Pure (string in -> string out) so it is
 * unit-tested; the store injects the result into one <style id="mixai-skin">.
 *
 * Rust already validated every value (colours only #hex / oklch(), names on an
 * allow-list, fonts as plain family names). We re-check here anyway: a value
 * that does not match is dropped, so a bug on either side can never inject CSS.
 */
import type { PackTokens } from "../bridge/packs.ts";
import { styleDecls, styleLayout, styleLook, styleWaves } from "../look/style-vars.ts";

export const COLOR_KEYS = [
    "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
    "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
    "accent", "accent-foreground", "destructive", "border", "input", "ring",
    "deck-a", "deck-b", "deck-c", "deck-d", "success", "warning",
] as const;

// A number is digits with an optional fraction: a dot needs a digit after it (CSS drops `5.`),
// same rule as `parse_num` in crates/decks-packs and `parseNum` in the Skin SDK.
const NUM = "(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)";
const COLOR_RE = new RegExp(`^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|oklch\\(\\s*${NUM}%?\\s+${NUM}\\s+${NUM}(\\s*\\/\\s*${NUM}%?)?\\s*\\))$`);
const FONT_RE = /^[A-Za-z0-9 -]{1,40}$/;
const DATA_URL_RE = /^data:(image\/(png|jpeg|webp|avif)|font\/woff2);base64,[A-Za-z0-9+/=]+$/;

export function isSafeColor(v: unknown): v is string {
    return typeof v === "string" && COLOR_RE.test(v.trim());
}

export interface SkinCss {
    css: string;
    /** Theme dimensions to hand to the shared ThemeProvider. */
    prefs: Partial<{ mode: "dark" | "light"; surface: "glass" | "solid" | "flat"; density: "comfortable" | "compact"; radius: "sm" | "md" | "lg"; accent: string }>;
    /** Base look of the skin (`data-look` on <html>). */
    look: "signature" | "classic";
    /** The skin asks for the virtual platter. */
    platter: boolean;
    /** Waveform arrangement in the waves panel. */
    waves: "stacked" | "overlay";
    /** Layout the skin selects when the user picks it (null = keep the current one). */
    layout: string | null;
}

/** Named accents of the design system a skin may select (anything else is ignored here). */
const ACCENT_NAMES = ["violet", "magenta", "cyan", "emerald", "amber", "rose"];

export function tokensToCss(tokens: PackTokens, assets: Record<string, string> = {}, fonts: { family: string; file: string; weight?: number; style?: string }[] = []): SkinCss {
    const decls: string[] = [];
    for (const [k, v] of Object.entries(tokens.colors ?? {})) {
        if ((COLOR_KEYS as readonly string[]).includes(k) && isSafeColor(v)) decls.push(`--${k}: ${v.trim()};`);
    }
    for (const [d, v] of Object.entries(tokens.decks ?? {})) {
        if (["a", "b", "c", "d"].includes(d) && isSafeColor(v)) decls.push(`--deck-${d}: ${v.trim()};`);
    }
    decls.push(...styleDecls(tokens.style));
    if (tokens.fontHeading && FONT_RE.test(tokens.fontHeading)) decls.push(`--font-heading: "${tokens.fontHeading}", var(--font-sans-fallback, system-ui);`);
    if (tokens.fontBody && FONT_RE.test(tokens.fontBody)) decls.push(`--font-sans: "${tokens.fontBody}", system-ui, sans-serif;`);

    const blocks: string[] = [];
    for (const f of fonts) {
        const url = assets[f.file];
        if (!FONT_RE.test(f.family) || !url || !DATA_URL_RE.test(url)) continue;
        const weight = Number.isInteger(f.weight) && f.weight! >= 100 && f.weight! <= 900 ? f.weight : 400;
        const style = f.style === "italic" ? "italic" : "normal";
        blocks.push(`@font-face { font-family: "${f.family}"; src: url("${url}") format("woff2"); font-weight: ${weight}; font-style: ${style}; font-display: swap; }`);
    }
    if (decls.length) blocks.push(`:root[data-skin] { ${decls.join(" ")} }`);
    const bg = tokens.background ? assets[tokens.background] : undefined;
    if (bg && DATA_URL_RE.test(bg)) {
        blocks.push(`:root[data-skin] body { background: linear-gradient(color-mix(in oklch, var(--background) 72%, transparent), color-mix(in oklch, var(--background) 72%, transparent)), url("${bg}") center / cover no-repeat fixed, var(--background); }`);
    }

    const prefs: SkinCss["prefs"] = {};
    if (tokens.mode === "dark" || tokens.mode === "light") prefs.mode = tokens.mode;
    if (tokens.surface === "glass" || tokens.surface === "solid" || tokens.surface === "flat") prefs.surface = tokens.surface;
    if (tokens.density === "comfortable" || tokens.density === "compact") prefs.density = tokens.density;
    if (tokens.radius === "sm" || tokens.radius === "md" || tokens.radius === "lg") prefs.radius = tokens.radius;
    if (tokens.accent && ACCENT_NAMES.includes(tokens.accent)) prefs.accent = tokens.accent;
    return {
        css: blocks.join("\n"),
        prefs,
        look: styleLook(tokens.style),
        platter: tokens.style?.platter === true,
        waves: styleWaves(tokens.style),
        layout: styleLayout(tokens.style),
    };
}

// ── WCAG contrast check for a skin (install-time gate) ─────────────────────

function hexToRgb(h: string): [number, number, number] | null {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(h);
    return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : null;
}

function oklchToRgb(v: string): [number, number, number] | null {
    const m = /oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)/.exec(v);
    if (!m) return null;
    const L = Number(m[1]) / (m[2] ? 100 : 1);
    const C = Number(m[3]);
    const H = (Number(m[4]) * Math.PI) / 180;
    const a = C * Math.cos(H);
    const b = C * Math.sin(H);
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ].map((x) => Math.min(1, Math.max(0, x)));
    // Return linear-light values flagged as already linear by encoding to sRGB.
    return lin.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)) as [number, number, number];
}

export function relativeLuminance(color: string): number | null {
    const rgb = color.startsWith("#") ? hexToRgb(color) : oklchToRgb(color);
    if (!rgb) return null;
    const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg: string, bg: string): number | null {
    const a = relativeLuminance(fg);
    const b = relativeLuminance(bg);
    if (a === null || b === null) return null;
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}

/** Pairs that must reach WCAG AA (4.5:1 text, 3:1 ring). Only checked when both colours are set by the skin. */
const PAIRS: [string, string, number][] = [
    ["foreground", "background", 4.5],
    ["card-foreground", "card", 4.5],
    ["muted-foreground", "background", 4.5],
    ["primary-foreground", "primary", 4.5],
    ["ring", "background", 3],
];

export function contrastProblems(tokens: PackTokens): { fg: string; bg: string; ratio: number; need: number }[] {
    const c = tokens.colors ?? {};
    const out: { fg: string; bg: string; ratio: number; need: number }[] = [];
    for (const [fg, bg, need] of PAIRS) {
        if (!c[fg] || !c[bg]) continue;
        const ratio = contrastRatio(c[fg]!, c[bg]!);
        if (ratio !== null && ratio < need) out.push({ fg, bg, ratio: Math.round(ratio * 100) / 100, need });
    }
    return out;
}
