// Colour syntax (port of pack.rs valid_color), conversions for DTCG import, and the WCAG
// contrast check (port of apps/mixai/src/packs/apply-tokens.ts contrastProblems).

export const COLOR_KEYS = [
    "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
    "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
    "accent", "accent-foreground", "destructive", "border", "input", "ring",
    "deck-a", "deck-b", "deck-c", "deck-d", "success", "warning",
];

/** Plain decimal number (optionally signed / fractional); no exponents, no units. */
function parseNum(s) {
    const body = s.startsWith("-") ? s.slice(1) : s;
    if (!body || body.length > 12 || !/^[0-9.]+$/.test(body) || (body.match(/\./g) ?? []).length > 1 || body === ".") return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
}

function parseNumPct(s, scale) {
    if (s.endsWith("%")) {
        const v = parseNum(s.slice(0, -1));
        return v === null ? null : (v / 100) * scale;
    }
    return parseNum(s);
}

/** `#rrggbb`, `#rrggbbaa`, `oklch(L C H)` or `oklch(L C H / A)`. Nothing else. */
export function validColor(c) {
    if (typeof c !== "string") return false;
    if (c.startsWith("#")) return /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c);
    if (!c.startsWith("oklch(") || !c.endsWith(")")) return false;
    const inner = c.slice(6, -1);
    const slash = inner.indexOf("/");
    const lch = slash < 0 ? inner : inner.slice(0, slash);
    const alpha = slash < 0 ? null : inner.slice(slash + 1).trim();
    const parts = lch.split(/\s+/).filter(Boolean);
    if (parts.length !== 3) return false;
    const l = parseNumPct(parts[0], 1);
    const ch = parseNum(parts[1]);
    const h = parseNum(parts[2]);
    const okLch = l !== null && l >= 0 && l <= 1 && ch !== null && ch >= 0 && ch <= 0.5 && h !== null && h >= 0 && h <= 360;
    if (alpha === null) return okLch;
    const a = parseNumPct(alpha, 1);
    return okLch && a !== null && a >= 0 && a <= 1;
}

const hex2 = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");

function hslToRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function alphaHex(a) {
    if (a === undefined || a === null) return "";
    const v = String(a).trim();
    const n = v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
    if (!Number.isFinite(n) || n >= 1) return "";
    return hex2(Math.max(0, n) * 255);
}

/**
 * Normalise a colour from a design tool to a pack colour: #rgb/#rgba/#rrggbb/#rrggbbaa,
 * rgb()/rgba(), hsl()/hsla() -> #rrggbb[aa]; oklch() kept as is. Returns null if unsupported.
 */
export function normalizeColor(input) {
    if (typeof input !== "string") return null;
    const v = input.trim();
    if (/^#[0-9a-fA-F]{3,4}$/.test(v)) {
        const out = "#" + [...v.slice(1)].map((c) => c + c).join("").toLowerCase();
        return out.length === 9 && out.endsWith("ff") ? out.slice(0, 7) : out;
    }
    if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) {
        const low = v.toLowerCase();
        return low.length === 9 && low.endsWith("ff") ? low.slice(0, 7) : low;
    }
    if (v.startsWith("oklch(")) {
        const compact = v.replace(/\s+/g, " ").replace(/\(\s+/, "(").replace(/\s+\)/, ")").replace(/\s*\/\s*/, " / ");
        return validColor(compact) ? compact : null;
    }
    let m = /^rgba?\(\s*([0-9.]+%?)[\s,]+([0-9.]+%?)[\s,]+([0-9.]+%?)\s*(?:[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(v);
    if (m) {
        const ch = (x) => (x.endsWith("%") ? (Number(x.slice(0, -1)) / 100) * 255 : Number(x));
        const rgb = [ch(m[1]), ch(m[2]), ch(m[3])];
        if (rgb.some((x) => !Number.isFinite(x))) return null;
        return "#" + rgb.map(hex2).join("") + alphaHex(m[4]);
    }
    m = /^hsla?\(\s*([0-9.]+)(?:deg)?[\s,]+([0-9.]+)%[\s,]+([0-9.]+)%\s*(?:[,/]\s*([0-9.]+%?))?\s*\)$/i.exec(v);
    if (m) {
        const rgb = hslToRgb(Number(m[1]) % 360, Number(m[2]) / 100, Number(m[3]) / 100);
        return "#" + rgb.map(hex2).join("") + alphaHex(m[4]);
    }
    return null;
}

// ── contrast (identical maths to apply-tokens.ts) ─────────────────────────────

function hexToRgb(h) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(h);
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
}

function oklchToRgb(v) {
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
    return lin.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
}

/** sRGB 0..1 triple for a pack colour (alpha ignored), or null. */
export function toSrgb(color) {
    return color.startsWith("#") ? hexToRgb(color) : oklchToRgb(color);
}

export function relativeLuminance(color) {
    const rgb = toSrgb(color);
    if (!rgb) return null;
    const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg, bg) {
    const a = relativeLuminance(fg);
    const b = relativeLuminance(bg);
    if (a === null || b === null) return null;
    const [hi, lo] = a > b ? [a, b] : [b, a];
    return (hi + 0.05) / (lo + 0.05);
}

export const CONTRAST_PAIRS = [
    ["foreground", "background", 4.5],
    ["card-foreground", "card", 4.5],
    ["muted-foreground", "background", 4.5],
    ["primary-foreground", "primary", 4.5],
    ["ring", "background", 3],
];

/** Pairs below WCAG AA; only checked when both colours are set. */
export function contrastProblems(colors = {}) {
    const out = [];
    for (const [fg, bg, need] of CONTRAST_PAIRS) {
        if (!colors[fg] || !colors[bg]) continue;
        const ratio = contrastRatio(colors[fg], colors[bg]);
        if (ratio !== null && ratio < need) out.push({ fg, bg, ratio: Math.round(ratio * 100) / 100, need });
    }
    return out;
}
