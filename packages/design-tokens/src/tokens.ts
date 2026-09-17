/**
 * MixAI design tokens — the single source of truth for every surface
 * (web, MixAI DJ desktop, Companion, native shell, TV apps, extension).
 *
 * Everything here is plain data. `build.ts` turns it into:
 *   dist/tokens.css        Tailwind v4 `@theme` + `data-*` dimension selectors (web, mixai, companion)
 *   dist/tokens.plain.css  same variables, no Tailwind directives (tizen, extension, native bootstrap)
 *   dist/tokens.json       for tooling / tests
 *   dist/Tokens.kt         Compose colours for tv-android
 *   dist/prehydrate.js     1 KB script that applies persisted prefs before first paint
 *
 * Colour model: OKLCH. Accents are described by HUE only; lightness/chroma per
 * role are fixed per mode so any hue (including a user-picked custom one)
 * yields accessible, consistent primaries.
 */

// ─── Theme dimensions ────────────────────────────────────────────────────────

export const MODES = ["light", "dark", "system"] as const;
export type Mode = (typeof MODES)[number];

export const ACCENTS = {
  violet: { hue: 285, label: { en: "Violet", ro: "Violet" } },
  magenta: { hue: 330, label: { en: "Magenta", ro: "Magenta" } },
  cyan: { hue: 200, label: { en: "Cyan", ro: "Cyan" } },
  emerald: { hue: 160, label: { en: "Emerald", ro: "Smarald" } },
  amber: { hue: 75, label: { en: "Amber", ro: "Ambră" } },
  rose: { hue: 15, label: { en: "Rose", ro: "Roz" } },
} as const;
export type AccentPreset = keyof typeof ACCENTS;
/** `custom:<hue 0-360>` or `artwork` (dynamic, derived from cover art) are also valid. */
export type Accent = AccentPreset | `custom:${number}` | "artwork";
export const DEFAULT_ACCENT: AccentPreset = "violet";

export const SURFACES = ["glass", "solid", "flat"] as const;
export type Surface = (typeof SURFACES)[number];

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const RADII = ["sm", "md", "lg"] as const;
export type Radius = (typeof RADII)[number];

export const MOTIONS = ["full", "reduced"] as const;
export type Motion = (typeof MOTIONS)[number];

export const LOCALES = ["ro", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export interface ThemePrefs {
  mode: Mode;
  accent: Accent;
  surface: Surface;
  density: Density;
  radius: Radius;
  motion: Motion;
  locale: Locale;
  /** Opt-in haptic + sound feedback (mobile / DJ actions). */
  feedback: boolean;
}

export const DEFAULT_PREFS: ThemePrefs = {
  mode: "system",
  accent: DEFAULT_ACCENT,
  surface: "glass",
  density: "comfortable",
  radius: "md",
  motion: "full",
  locale: "ro",
  feedback: false,
};

/** One localStorage key for every surface. Versioned for migrations. */
export const PREFS_STORAGE_KEY = "mixai:prefs:v1";
/** Legacy keys migrated into PREFS_STORAGE_KEY by the prehydrate script / ThemeProvider. */
export const LEGACY_KEYS = {
  theme: "theme", // web ThemeProvider v1 ("light" | "dark" | "system")
  locale: "mmo-locale", // web cookie name (also mirrored to localStorage by v2)
  mixaiUi: "mixai-ui", // apps/mixai zustand persist blob ({ theme, motion })
} as const;

/** `<html data-*>` attribute names the CSS keys off. */
export const DATA_ATTRS = {
  mode: "data-mode", // resolved: "light" | "dark"  (the `.dark` class is ALSO set for legacy variants)
  accent: "data-accent", // preset name | "custom" | "artwork"
  surface: "data-surface",
  density: "data-density",
  radius: "data-radius",
  motion: "data-motion",
} as const;
/** Custom / artwork hue is written as an inline CSS var on <html>. */
export const ACCENT_HUE_VAR = "--accent-h";

// ─── Colour roles (OKLCH L / C per mode; hue comes from the accent) ─────────

export interface Oklch {
  l: number;
  c: number;
  h: number | "accent";
  /** 0–1 alpha; omitted = 1 */
  a?: number;
}

const neutralHue = 285; // faint indigo bias so neutrals feel "nocturne", never pure grey

type RoleName =
  | "background"
  | "foreground"
  | "card"
  | "card-foreground"
  | "popover"
  | "popover-foreground"
  | "primary"
  | "primary-foreground"
  | "secondary"
  | "secondary-foreground"
  | "muted"
  | "muted-foreground"
  | "accent"
  | "accent-foreground"
  | "destructive"
  | "destructive-foreground"
  | "success"
  | "warning"
  | "info"
  | "border"
  | "input"
  | "ring"
  | "sidebar"
  | "sidebar-foreground"
  | "sidebar-primary"
  | "sidebar-primary-foreground"
  | "sidebar-accent"
  | "sidebar-accent-foreground"
  | "sidebar-border"
  | "sidebar-ring"
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5";

export const ROLES: Record<"light" | "dark", Record<RoleName, Oklch>> = {
  light: {
    background: { l: 0.99, c: 0.004, h: neutralHue },
    foreground: { l: 0.16, c: 0.02, h: neutralHue },
    card: { l: 1, c: 0, h: neutralHue },
    "card-foreground": { l: 0.16, c: 0.02, h: neutralHue },
    popover: { l: 1, c: 0, h: neutralHue },
    "popover-foreground": { l: 0.16, c: 0.02, h: neutralHue },
    primary: { l: 0.62, c: 0.21, h: "accent" },
    "primary-foreground": { l: 0.99, c: 0, h: neutralHue },
    secondary: { l: 0.965, c: 0.006, h: neutralHue },
    "secondary-foreground": { l: 0.21, c: 0.02, h: neutralHue },
    muted: { l: 0.965, c: 0.006, h: neutralHue },
    "muted-foreground": { l: 0.5, c: 0.02, h: neutralHue },
    accent: { l: 0.94, c: 0.04, h: "accent" },
    "accent-foreground": { l: 0.25, c: 0.12, h: "accent" },
    destructive: { l: 0.577, c: 0.245, h: 27 },
    "destructive-foreground": { l: 0.99, c: 0, h: 27 },
    success: { l: 0.7, c: 0.19, h: 150 },
    warning: { l: 0.8, c: 0.17, h: 85 },
    info: { l: 0.65, c: 0.18, h: 250 },
    border: { l: 0.91, c: 0.01, h: neutralHue },
    input: { l: 0.91, c: 0.01, h: neutralHue },
    ring: { l: 0.62, c: 0.21, h: "accent" },
    sidebar: { l: 0.98, c: 0.005, h: neutralHue },
    "sidebar-foreground": { l: 0.16, c: 0.02, h: neutralHue },
    "sidebar-primary": { l: 0.62, c: 0.21, h: "accent" },
    "sidebar-primary-foreground": { l: 0.99, c: 0, h: neutralHue },
    "sidebar-accent": { l: 0.955, c: 0.01, h: "accent" },
    "sidebar-accent-foreground": { l: 0.21, c: 0.02, h: neutralHue },
    "sidebar-border": { l: 0.91, c: 0.01, h: neutralHue },
    "sidebar-ring": { l: 0.62, c: 0.21, h: "accent" },
    "chart-1": { l: 0.62, c: 0.21, h: "accent" },
    "chart-2": { l: 0.68, c: 0.2, h: 330 },
    "chart-3": { l: 0.78, c: 0.13, h: 200 },
    "chart-4": { l: 0.55, c: 0.18, h: 300 },
    "chart-5": { l: 0.7, c: 0.16, h: 250 },
  },
  dark: {
    background: { l: 0.13, c: 0.02, h: neutralHue },
    foreground: { l: 0.96, c: 0.01, h: 80 }, // warm ivory, never pure white
    card: { l: 0.18, c: 0.02, h: neutralHue },
    "card-foreground": { l: 0.96, c: 0.01, h: 80 },
    popover: { l: 0.18, c: 0.02, h: neutralHue },
    "popover-foreground": { l: 0.96, c: 0.01, h: 80 },
    primary: { l: 0.7, c: 0.19, h: "accent" },
    "primary-foreground": { l: 0.14, c: 0.03, h: "accent" },
    secondary: { l: 0.25, c: 0.02, h: neutralHue },
    "secondary-foreground": { l: 0.96, c: 0.01, h: 80 },
    muted: { l: 0.25, c: 0.02, h: neutralHue },
    "muted-foreground": { l: 0.7, c: 0.02, h: neutralHue },
    accent: { l: 0.3, c: 0.06, h: "accent" },
    "accent-foreground": { l: 0.9, c: 0.08, h: "accent" },
    destructive: { l: 0.7, c: 0.19, h: 22 },
    "destructive-foreground": { l: 0.14, c: 0.03, h: 22 },
    success: { l: 0.75, c: 0.17, h: 150 },
    warning: { l: 0.82, c: 0.16, h: 85 },
    info: { l: 0.7, c: 0.16, h: 250 },
    border: { l: 1, c: 0, h: neutralHue, a: 0.1 },
    input: { l: 1, c: 0, h: neutralHue, a: 0.15 },
    ring: { l: 0.7, c: 0.19, h: "accent" },
    sidebar: { l: 0.16, c: 0.02, h: neutralHue },
    "sidebar-foreground": { l: 0.96, c: 0.01, h: 80 },
    "sidebar-primary": { l: 0.7, c: 0.19, h: "accent" },
    "sidebar-primary-foreground": { l: 0.14, c: 0.03, h: "accent" },
    "sidebar-accent": { l: 0.24, c: 0.03, h: "accent" },
    "sidebar-accent-foreground": { l: 0.96, c: 0.01, h: 80 },
    "sidebar-border": { l: 1, c: 0, h: neutralHue, a: 0.1 },
    "sidebar-ring": { l: 0.7, c: 0.19, h: "accent" },
    "chart-1": { l: 0.7, c: 0.19, h: "accent" },
    "chart-2": { l: 0.72, c: 0.2, h: 330 },
    "chart-3": { l: 0.8, c: 0.13, h: 200 },
    "chart-4": { l: 0.6, c: 0.18, h: 300 },
    "chart-5": { l: 0.74, c: 0.16, h: 250 },
  },
};

/** Brand signature — fixed, never re-hued (logo, hero gradient, splash). */
export const BRAND = {
  violet: "#7c5cff",
  magenta: "#e84ff0",
  cyan: "#22d3ee",
  violetDark: "#8b6dff",
  magentaDark: "#ef62f3",
  cyanDark: "#38dcf2",
  gradient: "linear-gradient(135deg, #7c5cff 0%, #e84ff0 100%)",
  gradientDark: "linear-gradient(135deg, #8b6dff 0%, #ef62f3 100%)",
  /** Deck colours for MixAI DJ — kept regardless of accent (D9). */
  deckA: "#22d3ee",
  deckB: "#ff4fa3",
  deckC: "#a3ff4f",
  deckD: "#ffb14f",
} as const;

// ─── Surface presets (glass / solid / flat) ─────────────────────────────────

export const SURFACE_VARS: Record<Surface, Record<string, string>> = {
  glass: {
    "--surface-alpha": "0.72",
    "--surface-blur": "18px",
    "--surface-border-alpha": "0.12",
    "--surface-shadow": "0 8px 32px -12px oklch(0 0 0 / 0.45), 0 0 0 1px oklch(1 0 0 / 0.04) inset",
    "--surface-glow": "0 0 40px -10px oklch(var(--primary-l) var(--primary-c) var(--accent-h) / 0.35)",
  },
  solid: {
    "--surface-alpha": "1",
    "--surface-blur": "0px",
    "--surface-border-alpha": "0.1",
    "--surface-shadow": "0 4px 16px -8px oklch(0 0 0 / 0.35)",
    "--surface-glow": "none",
  },
  flat: {
    "--surface-alpha": "1",
    "--surface-blur": "0px",
    "--surface-border-alpha": "0.16",
    "--surface-shadow": "none",
    "--surface-glow": "none",
  },
};

export const DENSITY_VARS: Record<Density, Record<string, string>> = {
  comfortable: {
    "--space-unit": "0.25rem",
    "--control-h": "2.5rem", // 40px
    "--control-h-sm": "2rem",
    "--control-h-lg": "3rem",
    "--row-h": "3rem",
    "--text-scale": "1",
  },
  compact: {
    "--space-unit": "0.2rem",
    "--control-h": "2.125rem", // 34px
    "--control-h-sm": "1.75rem",
    "--control-h-lg": "2.5rem",
    "--row-h": "2.375rem",
    "--text-scale": "0.94",
  },
};

export const RADIUS_VARS: Record<Radius, string> = {
  sm: "0.375rem",
  md: "0.625rem",
  lg: "1rem",
};

export const MOTION_VARS: Record<Motion, Record<string, string>> = {
  full: {
    "--dur-fast": "120ms",
    "--dur-base": "220ms",
    "--dur-slow": "400ms",
    "--dur-page": "320ms",
    "--ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
    "--ease-in-out": "cubic-bezier(0.4, 0, 0.2, 1)",
    "--ease-spring": "linear(0, 0.006, 0.025 2.8%, 0.101 6.1%, 0.539 18.9%, 0.721 25.3%, 0.849 31.5%, 0.937 38.1%, 0.968 41.8%, 0.991 45.7%, 1.006 50.1%, 1.015 55%, 1.017 63.9%, 1.001)",
  },
  reduced: {
    "--dur-fast": "0ms",
    "--dur-base": "0ms",
    "--dur-slow": "0ms",
    "--dur-page": "0ms",
    "--ease-out": "linear",
    "--ease-in-out": "linear",
    "--ease-spring": "linear",
  },
};

// ─── Layout ────────────────────────────────────────────────────────────────

export const BREAKPOINTS = {
  sm: "40rem",
  md: "48rem",
  lg: "64rem",
  xl: "80rem",
  "2xl": "96rem",
  "3xl": "120rem", // 1920
  "4xl": "160rem", // 2560
} as const;

export const CONTENT_WIDTHS = {
  sm: "40rem", // 640 — forms, settings
  md: "56rem", // 896 — reading, detail pages
  lg: "80rem", // 1280 — dashboards
  xl: "100rem", // 1600 — dense tables; still capped on ultra-wide
  full: "none",
} as const;

export const Z_INDEX = {
  base: 0,
  raised: 10,
  sticky: 20,
  sidebar: 30,
  player: 40,
  overlay: 50,
  modal: 60,
  popover: 70,
  toast: 80,
  tooltip: 90,
} as const;

export const FONTS = {
  sans: '"Inter", "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  heading: '"Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
} as const;

/** 10-foot UI (TV) overrides. */
export const TV = {
  rootFontSize: "24px",
  overscanX: "5vw",
  overscanY: "4vh",
  focusRingWidth: "4px",
  cardScaleFocused: "1.06",
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function oklchCss(c: Oklch, hueVar = "var(--accent-h)"): string {
  const h = c.h === "accent" ? hueVar : String(c.h);
  const a = c.a !== undefined && c.a < 1 ? ` / ${c.a}` : "";
  return `oklch(${c.l} ${c.c} ${h}${a})`;
}

export function parseAccent(accent: Accent): { attr: string; hue: number | null } {
  if (accent === "artwork") return { attr: "artwork", hue: null };
  if (accent.startsWith("custom:")) {
    const hue = Number(accent.slice(7));
    return { attr: "custom", hue: Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : ACCENTS.violet.hue };
  }
  const preset = ACCENTS[accent as AccentPreset];
  return { attr: accent, hue: preset ? preset.hue : ACCENTS.violet.hue };
}

export function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}
export function isSurface(v: unknown): v is Surface {
  return typeof v === "string" && (SURFACES as readonly string[]).includes(v);
}
export function isDensity(v: unknown): v is Density {
  return typeof v === "string" && (DENSITIES as readonly string[]).includes(v);
}
export function isRadius(v: unknown): v is Radius {
  return typeof v === "string" && (RADII as readonly string[]).includes(v);
}
export function isMotion(v: unknown): v is Motion {
  return typeof v === "string" && (MOTIONS as readonly string[]).includes(v);
}
export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}
export function isAccent(v: unknown): v is Accent {
  if (typeof v !== "string") return false;
  if (v === "artwork") return true;
  if (v.startsWith("custom:")) return Number.isFinite(Number(v.slice(7)));
  return v in ACCENTS;
}

/** Coerce any persisted blob into a valid ThemePrefs (unknown fields dropped, invalid → default). */
export function normalizePrefs(input: unknown): ThemePrefs {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    mode: isMode(o.mode) ? o.mode : DEFAULT_PREFS.mode,
    accent: isAccent(o.accent) ? o.accent : DEFAULT_PREFS.accent,
    surface: isSurface(o.surface) ? o.surface : DEFAULT_PREFS.surface,
    density: isDensity(o.density) ? o.density : DEFAULT_PREFS.density,
    radius: isRadius(o.radius) ? o.radius : DEFAULT_PREFS.radius,
    motion: isMotion(o.motion) ? o.motion : DEFAULT_PREFS.motion,
    locale: isLocale(o.locale) ? o.locale : DEFAULT_PREFS.locale,
    feedback: typeof o.feedback === "boolean" ? o.feedback : DEFAULT_PREFS.feedback,
  };
}
