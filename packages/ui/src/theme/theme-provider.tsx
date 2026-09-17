"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_PREFS, PREFS_STORAGE_KEY, normalizePrefs, type Accent, type ThemePrefs } from "@mmo/design-tokens";
import {
  PREFS_CHANGED_EVENT,
  applyPrefs,
  emitPrefsChanged,
  loadPrefs,
  resolveMode,
  savePrefs,
} from "./prefs-store.ts";

export interface ThemeContextValue {
  prefs: ThemePrefs;
  /** Resolved light/dark after `system` is applied. */
  resolvedMode: "light" | "dark";
  setPrefs: (patch: Partial<ThemePrefs>) => void;
  /** Convenience for the legacy `useTheme().setTheme` call sites. */
  setMode: (mode: ThemePrefs["mode"]) => void;
  setAccent: (accent: Accent) => void;
  /** Feed a hue derived from cover art; used only while `accent === "artwork"`. */
  setArtworkHue: (hue: number | null) => void;
  artworkHue: number | null;
  /** Reset to defaults. */
  reset: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Server-provided initial prefs (e.g. from a cookie) to avoid a client/server mismatch. */
  initialPrefs?: Partial<ThemePrefs>;
  /** Called after every persisted change — hook for per-profile cloud sync. */
  onChange?: (prefs: ThemePrefs) => void;
}

export function ThemeProvider({ children, initialPrefs, onChange }: ThemeProviderProps) {
  const [prefs, setPrefsState] = useState<ThemePrefs>(() => {
    if (typeof window === "undefined") return normalizePrefs({ ...DEFAULT_PREFS, ...initialPrefs });
    return loadPrefs();
  });
  const [artworkHue, setArtworkHue] = useState<number | null>(null);
  const [systemTick, setSystemTick] = useState(0);

  useLayoutEffect(() => {
    applyPrefs(prefs, undefined, artworkHue);
  }, [prefs, artworkHue, systemTick]);

  // React to OS changes while in system / full motion
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const queries = [
      window.matchMedia("(prefers-color-scheme: dark)"),
      window.matchMedia("(prefers-reduced-motion: reduce)"),
    ];
    const handler = () => setSystemTick((t) => t + 1);
    for (const q of queries) q.addEventListener("change", handler);
    return () => {
      for (const q of queries) q.removeEventListener("change", handler);
    };
  }, []);

  // Cross-tab / cross-surface sync
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_STORAGE_KEY && e.newValue) {
        try {
          setPrefsState(normalizePrefs(JSON.parse(e.newValue)));
        } catch {
          /* ignore */
        }
      }
    };
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<ThemePrefs>).detail;
      if (detail) setPrefsState((cur) => (JSON.stringify(cur) === JSON.stringify(detail) ? cur : normalizePrefs(detail)));
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(PREFS_CHANGED_EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PREFS_CHANGED_EVENT, onCustom);
    };
  }, []);

  const setPrefs = useCallback(
    (patch: Partial<ThemePrefs>) => {
      setPrefsState((cur) => {
        const next = normalizePrefs({ ...cur, ...patch });
        savePrefs(next);
        emitPrefsChanged(next);
        onChange?.(next);
        return next;
      });
    },
    [onChange],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      prefs,
      resolvedMode: resolveMode(prefs),
      setPrefs,
      setMode: (mode) => setPrefs({ mode }),
      setAccent: (accent) => setPrefs({ accent }),
      setArtworkHue,
      artworkHue,
      reset: () => setPrefs({ ...DEFAULT_PREFS }),
    }),
    // systemTick is intentionally in deps so resolvedMode re-computes on OS change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs, setPrefs, artworkHue, systemTick],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemePrefs(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useThemePrefs must be used within <ThemeProvider>");
  return ctx;
}

/**
 * Drop-in for apps/web's legacy `useTheme()` shape: `{ theme, setTheme, resolvedTheme }`.
 */
export function useTheme() {
  const { prefs, setMode, resolvedMode } = useThemePrefs();
  return { theme: prefs.mode, setTheme: setMode, resolvedTheme: resolvedMode };
}
