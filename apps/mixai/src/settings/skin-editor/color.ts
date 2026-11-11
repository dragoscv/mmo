/**
 * Colour conversion for the skin editor. A skin colour is `#rrggbb[aa]` or `oklch(L C H [/ A])`
 * (the two grammars the pack validator accepts); the native colour input only speaks `#rrggbb`.
 *
 * Which grammar the editor WRITES depends on the colour, because the look tints surfaces with
 * `color-mix(in oklch, …)` (hover, zebra, selected fills), which interpolates the hue, and a
 * near-grey hex operand has no hue there. Measured in the app's webview (see builtin-skins.ts):
 * - a grey with a visible tint must be oklch(): as hex, grey + grey keeps the chroma but loses
 *   the hue and blue-grey zebra rows turn pink;
 * - a grey with no visible tint must be hex: hueless, so a mix with a saturated colour takes that
 *   colour's hue. As oklch() it has a hue of its own and the mix lands between the two hues
 *   (a blue selection over a warm grey went olive).
 * So: chroma below `NEUTRAL_CHROMA` is stored as hex, everything else as oklch().
 */

export type Rgb = [number, number, number];

/** Below this OKLCH chroma a colour has no visible tint. */
export const NEUTRAL_CHROMA = 0.004;

const HEX_RE = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;
// Same number grammar as the pack validators (a dot needs a digit after it).
const NUM = "(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)";
const OKLCH_RE = new RegExp(`^oklch\\(\\s*(${NUM})(%?)\\s+(${NUM})\\s+(${NUM})(?:\\s*\\/\\s*(${NUM})(%?))?\\s*\\)$`);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export interface Oklch {
    l: number;
    c: number;
    h: number;
    /** 0..1; 1 when the colour has no alpha. */
    a: number;
}

/** sRGB (0..1, gamma encoded) → OKLCH. */
export function rgbToOklch([r, g, b]: Rgb, a = 1): Oklch {
    const lr = toLinear(r);
    const lg = toLinear(g);
    const lb = toLinear(b);
    const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
    const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
    const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
    const c = Math.hypot(A, B);
    let h = (Math.atan2(B, A) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { l: L, c, h: c < 1e-4 ? 0 : h, a };
}

/** OKLCH → sRGB (0..1, gamma encoded), clipped to the sRGB gamut per channel. */
export function oklchToRgb({ l, c, h }: Pick<Oklch, "l" | "c" | "h">): Rgb {
    const hr = (h * Math.PI) / 180;
    const A = c * Math.cos(hr);
    const B = c * Math.sin(hr);
    const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
    return [
        toGamma(clamp01(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
        toGamma(clamp01(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
        toGamma(clamp01(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
    ];
}

/** Parse either grammar. Null when the text is not a colour the validator accepts. */
export function parseColor(text: string): Oklch | null {
    const v = text.trim();
    const hex = HEX_RE.exec(v);
    if (hex) {
        const n = hex[1]!;
        const rgb: Rgb = [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255];
        return rgbToOklch(rgb, hex[2] ? parseInt(hex[2], 16) / 255 : 1);
    }
    const ok = OKLCH_RE.exec(v);
    if (!ok) return null;
    const l = Number(ok[1]) / (ok[2] ? 100 : 1);
    const c = Number(ok[3]);
    const h = Number(ok[4]);
    const a = ok[5] === undefined ? 1 : Number(ok[5]) / (ok[6] ? 100 : 1);
    if (![l, c, h, a].every(Number.isFinite) || l > 1 || c > 0.5 || h > 360 || a > 1) return null;
    return { l, c, h, a };
}

export function isColorText(text: string): boolean {
    return parseColor(text) !== null;
}

const hex2 = (x: number) =>
    Math.round(clamp01(x) * 255)
        .toString(16)
        .padStart(2, "0");

export function rgbToHex([r, g, b]: Rgb): string {
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * `#rrggbb` for the native colour input (alpha dropped: the input cannot show it). Text that is
 * not a colour gives `fallback`, or black when none is passed (the input needs some value).
 */
export function toHex(text: string, fallback?: string): string {
    const c = parseColor(text);
    if (!c) return fallback ?? rgbToHex([0, 0, 0]);
    return rgbToHex(oklchToRgb(c));
}

const trim = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/**
 * Canonical `oklch(L C H)` text; alpha kept when < 1. Four decimals for L and C and two for H:
 * enough for an 8-bit sRGB colour to come back as the same `#rrggbb` (three were not).
 */
export function formatOklch(c: Oklch): string {
    const base = `${trim(clamp01(c.l), 4)} ${trim(Math.max(0, c.c), 4)} ${trim(((c.h % 360) + 360) % 360, 2)}`;
    return c.a < 0.999 ? `oklch(${base} / ${trim(clamp01(c.a), 2)})` : `oklch(${base})`;
}

/** Any accepted colour text → canonical oklch() text. Null when it is not a colour. */
export function toOklchText(text: string): string | null {
    const c = parseColor(text);
    return c ? formatOklch(c) : null;
}

/**
 * The text the editor stores for a colour: hex for a colour with no visible tint, oklch() for
 * everything else (see the note at the top of this file).
 */
export function storeText(c: Oklch): string {
    if (c.c >= NEUTRAL_CHROMA) return formatOklch(c);
    return c.a < 0.999 ? `${rgbToHex(oklchToRgb(c))}${hex2(c.a)}` : rgbToHex(oklchToRgb(c));
}

/** Any accepted colour text → the text the editor stores for it. Null when it is not a colour. */
export function normalizeColorText(text: string): string | null {
    const c = parseColor(text);
    return c ? storeText(c) : null;
}

/**
 * What the editor stores for a value picked in the native colour input, keeping the alpha of
 * the value it replaces.
 */
export function fromPicker(hex: string, previous?: string): string | null {
    const c = parseColor(hex);
    if (!c) return null;
    const prev = previous ? parseColor(previous) : null;
    return storeText({ ...c, a: prev ? prev.a : 1 });
}
