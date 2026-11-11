/**
 * Pure model of the live skin editor: which fields exist and in which group, how a draft
 * (`PackTokens`) is edited, cleaned and turned into a `pack_build` / `pack_export` request,
 * and which colour pairs are checked for contrast. No DOM, no React: unit-tested with node.
 */
import type { PackExportRequest, PackTokens } from "../../bridge/packs.ts";
import { COLOR_KEYS, contrastRatio, isSafeColor } from "../../packs/apply-tokens.ts";
import { STYLE_COLORS, STYLE_LOOKS, STYLE_SIZES, STYLE_WAVES, isStyleColor, styleLayout, type PackStyle, type StyleColorKey, type StyleSizeKey } from "../../look/style-vars.ts";

export const GROUPS = ["base", "colors", "decks", "wave", "cues", "shape", "options"] as const;
export type GroupId = (typeof GROUPS)[number];

export const DECK_IDS = ["a", "b", "c", "d"] as const;
export type DeckLetter = (typeof DECK_IDS)[number];

/** Theme colours a skin may set (the deck colours are edited in their own group, through `decks`). */
export const THEME_COLOR_KEYS: readonly string[] = COLOR_KEYS.filter((k) => !k.startsWith("deck-"));

/** Group "Colours", in three sections: every theme colour and every non-waveform, non-cue style colour. */
export const COLOR_SECTIONS: readonly { id: "surfaces" | "text" | "states"; theme: readonly string[]; style: readonly StyleColorKey[] }[] = [
    { id: "surfaces", theme: ["background", "card", "popover", "secondary", "muted", "accent", "border", "input"], style: ["well", "line"] },
    { id: "text", theme: ["foreground", "card-foreground", "popover-foreground", "secondary-foreground", "muted-foreground", "accent-foreground"], style: ["faint"] },
    { id: "states", theme: ["primary", "primary-foreground", "ring", "destructive", "success", "warning"], style: ["on", "onFg", "play", "playFg", "cue", "alert"] },
];
export const WAVE_COLORS: readonly StyleColorKey[] = ["waveBg", "waveLow", "waveMid", "waveHigh", "waveGrid", "waveDownbeat", "wavePlayhead", "wavePlayheadCap"];
export const CUE_COLORS: readonly StyleColorKey[] = ["cue1", "cue2", "cue3", "cue4", "cue5", "cue6", "cue7", "cue8"];
export const SHAPE_SIZES: readonly StyleSizeKey[] = ["panelGap", "panelRadius", "panelPad", "controlRadius", "padRadius", "controlHeight", "titlebarHeight"];
export const WAVE_SIZES: readonly StyleSizeKey[] = ["wavePlayedAlpha"];

/** Named accents of the design system (same list as the applier). */
export const ACCENTS = ["violet", "magenta", "cyan", "emerald", "amber", "rose"] as const;

/**
 * The custom property that holds the EFFECTIVE value of a style colour. Mostly the property the
 * skin sets; PLAY and the waveform bands are set through a `--skin-*` hook and read elsewhere.
 */
const EFFECTIVE_PROP: Partial<Record<StyleColorKey, string>> = { play: "--play", waveLow: "--wave-low", waveMid: "--wave-mid", waveHigh: "--wave-high" };

export function styleColorProp(key: StyleColorKey): string {
    return EFFECTIVE_PROP[key] ?? STYLE_COLORS[key];
}
export function themeColorProp(key: string): string {
    return `--${key}`;
}
export function deckColorProp(d: DeckLetter): string {
    return `--deck-${d}`;
}

/** Slider step of a size: 0.05 for the unitless alpha, 1 for everything else. */
export function sizeStep(key: StyleSizeKey): number {
    return STYLE_SIZES[key].max <= 1 ? 0.05 : 1;
}

export function clampSize(key: StyleSizeKey, value: number): number {
    const { min, max } = STYLE_SIZES[key];
    const step = sizeStep(key);
    const v = Math.round(Math.min(max, Math.max(min, value)) / step) * step;
    return Number(v.toFixed(2));
}

// ── editing a draft (every function returns a new object; `null` removes the entry) ─────────

function withEntry<T>(map: Record<string, T> | undefined, key: string, value: T | null): Record<string, T> | undefined {
    const next = { ...(map ?? {}) };
    if (value === null) delete next[key];
    else next[key] = value;
    return Object.keys(next).length ? next : undefined;
}

function prune<T extends object>(o: T): T {
    const out = { ...o } as Record<string, unknown>;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out as T;
}

export function setThemeColor(t: PackTokens, key: string, value: string | null): PackTokens {
    if (!THEME_COLOR_KEYS.includes(key)) return t;
    return prune({ ...t, colors: withEntry(t.colors, key, value) });
}

export function setDeckColor(t: PackTokens, d: DeckLetter, value: string | null): PackTokens {
    return prune({ ...t, decks: withEntry(t.decks as Record<string, string> | undefined, d, value) as PackTokens["decks"] });
}

function withStyle(t: PackTokens, style: PackStyle): PackTokens {
    const s = prune(style);
    return prune({ ...t, style: Object.keys(s).length ? s : undefined });
}

export function setStyleColor(t: PackTokens, key: StyleColorKey, value: string | null): PackTokens {
    return withStyle(t, { ...t.style, colors: withEntry(t.style?.colors as Record<string, string> | undefined, key, value) as PackStyle["colors"] });
}

export function setStyleSize(t: PackTokens, key: StyleSizeKey, value: number | null): PackTokens {
    return withStyle(t, { ...t.style, sizes: withEntry(t.style?.sizes as Record<string, number> | undefined, key, value === null ? null : clampSize(key, value)) as PackStyle["sizes"] });
}

/** Look / platter / waves / layout. `undefined` in the patch removes the key. */
export function setStyleOption(t: PackTokens, patch: Partial<Pick<PackStyle, "look" | "platter" | "waves" | "layout">>): PackTokens {
    return withStyle(t, { ...t.style, ...patch });
}

/** Mode / accent. `undefined` in the patch removes the key (the user's own setting shows). */
export function setBase(t: PackTokens, patch: Partial<Pick<PackTokens, "mode" | "accent">>): PackTokens {
    return prune({ ...t, ...patch });
}

/**
 * What the editor previews, saves and exports: only keys the validators know, only valid
 * values, no empty objects. Fonts and a background image are dropped (the editor cannot bundle
 * the files they point to).
 */
export function cleanTokens(t: PackTokens): PackTokens {
    const out: PackTokens = {};
    if (t.mode === "dark" || t.mode === "light") out.mode = t.mode;
    if (t.accent && (ACCENTS as readonly string[]).includes(t.accent)) out.accent = t.accent;
    if (t.surface === "glass" || t.surface === "solid" || t.surface === "flat") out.surface = t.surface;
    if (t.density === "comfortable" || t.density === "compact") out.density = t.density;
    if (t.radius === "sm" || t.radius === "md" || t.radius === "lg") out.radius = t.radius;
    const colors: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.colors ?? {})) if ((COLOR_KEYS as readonly string[]).includes(k) && isSafeColor(v)) colors[k] = v.trim();
    if (Object.keys(colors).length) out.colors = colors;
    const decks: Partial<Record<DeckLetter, string>> = {};
    for (const d of DECK_IDS) {
        const v = t.decks?.[d];
        if (isSafeColor(v)) decks[d] = v.trim();
    }
    if (Object.keys(decks).length) out.decks = decks;
    const s = t.style;
    if (s && typeof s === "object") {
        const style: PackStyle = {};
        if ((STYLE_LOOKS as readonly unknown[]).includes(s.look)) style.look = s.look;
        if (typeof s.platter === "boolean") style.platter = s.platter;
        if ((STYLE_WAVES as readonly unknown[]).includes(s.waves)) style.waves = s.waves;
        const layout = styleLayout(s);
        if (layout) style.layout = layout;
        const sc: Partial<Record<StyleColorKey, string>> = {};
        for (const [k, v] of Object.entries(s.colors ?? {})) if (Object.hasOwn(STYLE_COLORS, k) && isStyleColor(v)) sc[k as StyleColorKey] = v.trim();
        if (Object.keys(sc).length) style.colors = sc;
        const sz: Partial<Record<StyleSizeKey, number>> = {};
        for (const [k, v] of Object.entries(s.sizes ?? {})) {
            if (!Object.hasOwn(STYLE_SIZES, k) || typeof v !== "number" || !Number.isFinite(v)) continue;
            const spec = STYLE_SIZES[k as StyleSizeKey];
            if (v >= spec.min && v <= spec.max) sz[k as StyleSizeKey] = v;
        }
        if (Object.keys(sz).length) style.sizes = sz;
        if (Object.keys(style).length) out.style = style;
    }
    return out;
}

// ── identity of a saved skin ────────────────────────────────────────────────────────────────

export const USER_SKIN_PREFIX = "user.skin.";
/** `data-skin` value while the editor previews a draft. */
export const DRAFT_SKIN_ID = `${USER_SKIN_PREFIX}editor-draft`;

/** Lowercase a–z / 0–9 words joined by "-" (diacritics folded), at most 40 characters. */
export function slugify(name: string): string {
    return name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
}

/** `user.skin.<slug>`, or null when the name has no letter or digit. */
export function skinId(name: string): string | null {
    const slug = slugify(name);
    return slug ? `${USER_SKIN_PREFIX}${slug}` : null;
}

export function isUserSkinId(id: string | null | undefined): boolean {
    return typeof id === "string" && id.startsWith(USER_SKIN_PREFIX);
}

/** First save = 1.0.0; saving over an installed skin bumps its patch number. */
export function nextVersion(installed?: string): string {
    const m = installed ? /^(\d{1,9})\.(\d{1,9})\.(\d{1,8})$/.exec(installed) : null;
    return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

export const NAME_MAX = 60;

export function buildRequest(draft: PackTokens, meta: { name: string; author: string; description?: string; version: string }): PackExportRequest | null {
    const name = meta.name.trim().slice(0, NAME_MAX);
    const id = skinId(name);
    if (!id) return null;
    return { id, name, author: meta.author.trim().slice(0, NAME_MAX) || "DJ", description: (meta.description ?? "").trim().slice(0, 500), version: meta.version, tokens: cleanTokens(draft) };
}

// ── contrast of a draft ────────────────────────────────────────────────────────────────────

export type FieldRef = { kind: "theme"; key: string } | { kind: "style"; key: StyleColorKey };

export function fieldProp(f: FieldRef): string {
    return f.kind === "theme" ? themeColorProp(f.key) : styleColorProp(f.key);
}

export function fieldValue(t: PackTokens, f: FieldRef): string | undefined {
    return f.kind === "theme" ? t.colors?.[f.key] : t.style?.colors?.[f.key];
}

const th = (key: string): FieldRef => ({ kind: "theme", key });
const st = (key: StyleColorKey): FieldRef => ({ kind: "style", key });

/** Text on its backdrop needs 4.5:1; a state fill / focus ring against the panel needs 3:1. */
export const CONTRAST_PAIRS: readonly [FieldRef, FieldRef, number][] = [
    [th("foreground"), th("background"), 4.5],
    [th("foreground"), th("card"), 4.5],
    [th("card-foreground"), th("card"), 4.5],
    [th("foreground"), th("secondary"), 4.5],
    [th("muted-foreground"), th("card"), 4.5],
    [st("faint"), th("card"), 4.5],
    [st("faint"), th("secondary"), 4.5],
    [th("foreground"), st("well"), 4.5],
    [th("primary-foreground"), th("primary"), 4.5],
    [st("onFg"), st("on"), 4.5],
    [st("playFg"), st("play"), 4.5],
    [st("on"), th("card"), 3],
    [th("ring"), th("card"), 3],
];

export interface ContrastIssue {
    fg: FieldRef;
    bg: FieldRef;
    ratio: number;
    need: number;
}

/**
 * Contrast problems of what the user SEES: a colour the draft does not set is read from the
 * running app through `effective(prop)` (a `#rrggbb` / `oklch()` string, or null when unknown).
 * A pair is only reported when the draft sets at least one of its two colours.
 */
export function draftProblems(t: PackTokens, effective: (prop: string) => string | null): ContrastIssue[] {
    const out: ContrastIssue[] = [];
    for (const [fg, bg, need] of CONTRAST_PAIRS) {
        const a = fieldValue(t, fg);
        const b = fieldValue(t, bg);
        if (a === undefined && b === undefined) continue;
        const fgc = a ?? effective(fieldProp(fg));
        const bgc = b ?? effective(fieldProp(bg));
        if (!fgc || !bgc) continue;
        const ratio = contrastRatio(fgc, bgc);
        if (ratio !== null && ratio < need) out.push({ fg, bg, ratio: Math.round(ratio * 100) / 100, need });
    }
    return out;
}
