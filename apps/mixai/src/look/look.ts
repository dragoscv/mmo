/**
 * Runtime side of the Decks look layer (see ./look.css for the cascade contract).
 *
 * - `data-look` on <html>: "signature" (default) or "classic" (built-in skin "Glass (classic)").
 * - A change bus: skins rewrite <style id="mixai-skin"> without touching an attribute, so
 *   anything that caches computed colours or sizes (canvases, the layout solver gap)
 *   subscribes here instead of guessing with a MutationObserver.
 * - One-time migration of the theme prefs to the new default (flat, compact, green accent).
 */
import { useSyncExternalStore } from "react";
import { applyPrefs, emitPrefsChanged, loadPrefs, savePrefs } from "@mmo/ui/theme";

export const LOOKS = ["signature", "classic"] as const;
export type Look = (typeof LOOKS)[number];
export const DEFAULT_LOOK: Look = "signature";

export const LOOK_CHANGED_EVENT = "mixai:look-changed";
const MIGRATED_KEY = "mixai-look-v2";

export function isLook(v: unknown): v is Look {
    return typeof v === "string" && (LOOKS as readonly string[]).includes(v);
}

let version = 0;
const listeners = new Set<() => void>();

/** Tell every subscriber that computed look values may have changed. */
export function emitLookChanged(): void {
    version += 1;
    for (const l of listeners) l();
    if (typeof window !== "undefined") window.dispatchEvent(new Event(LOOK_CHANGED_EVENT));
}

export function subscribeLook(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

let observing = false;
/** Theme attributes (mode, accent, density, booth, palettes…) also change look values. */
function observeRoot(): void {
    if (observing || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    observing = true;
    new MutationObserver(() => emitLookChanged()).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-look", "data-skin", "data-skin-platter", "data-skin-waves", "data-platter", "data-mode", "data-accent", "data-surface", "data-density", "data-radius", "data-booth", "data-cue-palette", "data-deck-palette", "data-contrast", "style", "class"],
    });
}

/** Monotonic counter that bumps on every look change (use as an effect dependency). */
export function useLookVersion(): number {
    observeRoot();
    return useSyncExternalStore(subscribeLook, () => version, () => 0);
}

export function currentLook(): Look {
    if (typeof document === "undefined") return DEFAULT_LOOK;
    const v = document.documentElement.dataset.look;
    return isLook(v) ? v : DEFAULT_LOOK;
}

/** Set `data-look`; subscribers are told only when it changed. */
export function applyLook(look: Look): void {
    if (typeof document === "undefined") return;
    if (document.documentElement.dataset.look === look) return;
    document.documentElement.dataset.look = look;
    emitLookChanged();
}

/** Parse a unitless or px custom property of <html>; `fallback` when unset or not a number. */
export function readLookNumber(name: string, fallback: number): number {
    if (typeof document === "undefined") return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
}

/** Layout gap between panels in px: the look's `--panel-gap`, or `fallback` (classic = 12). */
export function useLookNumber(name: string, fallback: number): number {
    const v = useLookVersion();
    void v;
    return readLookNumber(name, fallback);
}

/** Virtual platter visible: the user's setting (Settings → Appearance) or the active skin. */
export function usePlatter(): boolean {
    const v = useLookVersion();
    void v;
    if (typeof document === "undefined") return false;
    const d = document.documentElement.dataset;
    return d.platter === "on" || d.skinPlatter === "on";
}

/**
 * Waveform arrangement of the waves panel: "overlay" (every deck in one lane) when the active
 * skin asks for it (`data-skin-waves="overlay"` on <html>, set by the pack store), else "stacked".
 */
export function useWaveMode(): "stacked" | "overlay" {
    const v = useLookVersion();
    void v;
    if (typeof document === "undefined") return "stacked";
    return document.documentElement.dataset.skinWaves === "overlay" ? "overlay" : "stacked";
}

/** Prefs of the Signature default. Only applied once, by `migrateLookOnce`. */
export const SIGNATURE_PREFS = { mode: "dark", accent: "emerald", surface: "flat", density: "compact", radius: "sm" } as const;

/**
 * One-time move of an existing install (or a first run) to the new default look: flat
 * surfaces, compact density, small radii and the green accent. Runs before first paint
 * (called from main.tsx) so the old look never flashes. Of the values a user had chosen only
 * a non-default ACCENT is kept: mode, surface, density and radius all move to the Signature
 * values (so a light-mode install becomes dark once; the Signature look was designed dark and
 * its light mode has not been reviewed). Returns true when it changed anything.
 */
export function migrateLookOnce(storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): boolean {
    if (!storage) return false;
    try {
        if (storage.getItem(MIGRATED_KEY)) return false;
        storage.setItem(MIGRATED_KEY, "1");
    } catch {
        return false;
    }
    const prev = loadPrefs();
    const next = {
        ...prev,
        mode: SIGNATURE_PREFS.mode,
        surface: SIGNATURE_PREFS.surface,
        density: SIGNATURE_PREFS.density,
        radius: SIGNATURE_PREFS.radius,
        // "violet" was the old default, not a choice: replace only that.
        accent: prev.accent === "violet" ? SIGNATURE_PREFS.accent : prev.accent,
    } as typeof prev;
    savePrefs(next);
    applyPrefs(next);
    emitPrefsChanged(next);
    return true;
}
