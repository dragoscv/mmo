/**
 * Framework-agnostic prefs store. Works in web (Next), mixai (Vite), companion (Electron
 * renderer) and any vanilla page. React binding lives in theme-provider.tsx.
 */
import {
  ACCENT_HUE_VAR,
  DATA_ATTRS,
  DEFAULT_PREFS,
  LEGACY_KEYS,
  PREFS_STORAGE_KEY,
  normalizePrefs,
  parseAccent,
  type ThemePrefs,
} from "@mmo/design-tokens";

export type { ThemePrefs };

export const PREFS_CHANGED_EVENT = "mixai:prefs-changed";
/** Kept for apps/web's existing preference-sync listener. */
export const LEGACY_PREF_EVENT = "mmo-preference-changed";

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(): PrefsStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLegacy(storage: PrefsStorage): Partial<ThemePrefs> {
  const out: Partial<ThemePrefs> = {};
  const theme = storage.getItem(LEGACY_KEYS.theme);
  if (theme === "light" || theme === "dark" || theme === "system") out.mode = theme;
  const mixaiUi = storage.getItem(LEGACY_KEYS.mixaiUi);
  if (mixaiUi) {
    try {
      const parsed = JSON.parse(mixaiUi) as { state?: Record<string, unknown> } & Record<string, unknown>;
      const s = (parsed.state ?? parsed) as Record<string, unknown>;
      if (s.motion === "minimal") out.motion = "reduced";
      if (s.theme === "flat-pro") out.surface = "flat";
      if (s.theme === "studio-metal") out.surface = "solid";
    } catch {
      /* ignore */
    }
  }
  if (typeof document !== "undefined") {
    const m = document.cookie.match(new RegExp(`(?:^|; )${LEGACY_KEYS.locale}=(ro|en)`));
    if (m) out.locale = m[1] as ThemePrefs["locale"];
  }
  return out;
}

export function loadPrefs(storage: PrefsStorage | null = safeStorage()): ThemePrefs {
  if (!storage) return { ...DEFAULT_PREFS };
  const raw = storage.getItem(PREFS_STORAGE_KEY);
  if (raw) {
    try {
      return normalizePrefs(JSON.parse(raw));
    } catch {
      /* fall through to legacy */
    }
  }
  const migrated = normalizePrefs({ ...DEFAULT_PREFS, ...readLegacy(storage) });
  // Mobile default: solid surfaces (glass = blur cost) unless the user picked explicitly.
  if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches && migrated.surface === "glass") {
    migrated.surface = "solid";
  }
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(migrated));
  } catch {
    /* quota / private mode */
  }
  return migrated;
}

export function savePrefs(prefs: ThemePrefs, storage: PrefsStorage | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    // keep legacy mirrors in sync for code not yet migrated
    storage.setItem(LEGACY_KEYS.theme, prefs.mode);
  } catch {
    /* ignore */
  }
}

export function systemMode(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function systemReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function resolveMode(prefs: ThemePrefs): "light" | "dark" {
  return prefs.mode === "system" ? systemMode() : prefs.mode;
}

/**
 * Write prefs to <html>. Idempotent; identical to what prehydrate.js does so
 * hydration never fights the pre-paint state.
 */
export function applyPrefs(prefs: ThemePrefs, root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null, artworkHue?: number | null): void {
  if (!root) return;
  const mode = resolveMode(prefs);
  root.setAttribute(DATA_ATTRS.mode, mode);
  root.classList.remove("light", "dark");
  root.classList.add(mode);
  root.style.colorScheme = mode;

  const { attr, hue } = parseAccent(prefs.accent);
  root.setAttribute(DATA_ATTRS.accent, attr);
  const effectiveHue = attr === "artwork" ? artworkHue ?? null : hue;
  if (effectiveHue != null && Number.isFinite(effectiveHue)) root.style.setProperty(ACCENT_HUE_VAR, String(effectiveHue));
  else if (attr !== "artwork") root.style.removeProperty(ACCENT_HUE_VAR);

  root.setAttribute(DATA_ATTRS.surface, prefs.surface);
  root.setAttribute(DATA_ATTRS.density, prefs.density);
  root.setAttribute(DATA_ATTRS.radius, prefs.radius);
  root.setAttribute(DATA_ATTRS.motion, systemReducedMotion() ? "reduced" : prefs.motion);
  root.setAttribute("lang", prefs.locale);
  updateThemeColorMeta(root);
}

/** Keep `<meta name="theme-color">` in step with the resolved background so the OS chrome matches. */
export function updateThemeColorMeta(root: HTMLElement): void {
  if (typeof document === "undefined") return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(root).getPropertyValue("--background").trim();
  if (bg) meta.content = bg;
}

export function emitPrefsChanged(prefs: ThemePrefs): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PREFS_CHANGED_EVENT, { detail: prefs }));
  window.dispatchEvent(new Event(LEGACY_PREF_EVENT));
}
