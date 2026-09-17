"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useThemePrefs } from "../theme/theme-provider";

// ─── useMediaQuery ──────────────────────────────────────────────────────────

export function useMediaQuery(query: string, serverDefault = false): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverDefault),
    () => serverDefault,
  );
}

export const useIsMobile = () => useMediaQuery("(max-width: 47.99rem)");
export const useIsTouch = () => useMediaQuery("(pointer: coarse)");
export const useIsUltrawide = () => useMediaQuery("(min-aspect-ratio: 21/9)");
export const useIsStandalone = () => useMediaQuery("(display-mode: standalone)");
export const usePrefersReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");

// ─── useSafeArea ────────────────────────────────────────────────────────────

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function useSafeArea(): SafeArea {
  const [area, setArea] = useState<SafeArea>({ top: 0, right: 0, bottom: 0, left: 0 });
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const px = (n: string) => parseFloat(cs.getPropertyValue(n)) || 0;
      setArea({ top: px("--safe-top"), right: px("--safe-right"), bottom: px("--safe-bottom"), left: px("--safe-left") });
    };
    read();
    window.addEventListener("resize", read);
    window.addEventListener("orientationchange", read);
    return () => {
      window.removeEventListener("resize", read);
      window.removeEventListener("orientationchange", read);
    };
  }, []);
  return area;
}

// ─── useHaptics ─────────────────────────────────────────────────────────────

export type HapticPattern = "tap" | "success" | "warning" | "error" | "heavy";

const PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 8,
  success: [10, 30, 14],
  warning: [20, 40, 20],
  error: [40, 60, 40, 60, 40],
  heavy: 30,
};

/**
 * Haptic + optional sound cue. No-ops unless the user opted in via `prefs.feedback`.
 * Vibration API is Android-only; iOS Safari silently ignores it.
 */
export function useHaptics() {
  const { prefs } = useThemePrefs();
  return useCallback(
    (pattern: HapticPattern = "tap") => {
      if (!prefs.feedback) return;
      try {
        navigator.vibrate?.(PATTERNS[pattern]);
      } catch {
        /* unsupported */
      }
      playCue(pattern);
    },
    [prefs.feedback],
  );
}

let audioCtx: AudioContext | null = null;
function playCue(pattern: HapticPattern) {
  if (typeof window === "undefined" || !("AudioContext" in window)) return;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const freq = { tap: 880, success: 1320, warning: 660, error: 440, heavy: 330 }[pattern];
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  } catch {
    /* autoplay policy etc. */
  }
}

// ─── useContainerSize ───────────────────────────────────────────────────────

export function useContainerSize<T extends HTMLElement>(): [(node: T | null) => void, { width: number; height: number }] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [node, setNode] = useState<T | null>(null);
  useEffect(() => {
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, size];
}

// ─── useDebouncedValue ──────────────────────────────────────────────────────

export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}
