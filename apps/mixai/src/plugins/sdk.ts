/**
 * MIXAI Plugin SDK — the stable contract third-party (and built-in) plugins
 * code against.
 *
 * A plugin is a small, declarative object: metadata + an optional React panel
 * + optional lifecycle hooks. The host (see `host.tsx` / `plugin-store.ts`)
 * owns activation, persistence of the enabled set, and wiring the live audio
 * context in. Plugins NEVER import the engine, stores, or Tauri directly —
 * everything they're allowed to touch arrives through {@link PluginContext}.
 * That keeps the surface area small, sandbox-friendly, and forward-compatible:
 * we can later run untrusted plugins in a worker/iframe behind the same API.
 */

import type { ReactNode } from "react";
import type { DeckId, MixerState } from "@/bridge/types";

/** Semantic plugin categories — drives grouping in the plugin manager. */
export type PluginCategory = "effect" | "visual" | "assistant" | "utility";

/** The subset of engine transport/mix controls plugins may drive. Mirrors the
 *  real engine but is intentionally curated: no file/MIDI/device access, no
 *  recording — those stay host-owned. */
export interface PluginEngine {
    play(deck: DeckId): void;
    pause(deck: DeckId): void;
    setVolume(deck: DeckId, value: number): void;
    setEq(deck: DeckId, band: "low" | "mid" | "high", db: number): void;
    setFilter(deck: DeckId, value: number): void;
    setCrossfader(value: number): void;
    sync(deck: DeckId): void;
    setFxKind(deck: DeckId, kind: number): void;
    setFxWet(deck: DeckId, wet: number): void;
    setFxBeats(deck: DeckId, beats: number): void;
}

/** Everything a plugin is allowed to read/do. Passed to the panel component
 *  (as a prop) and to lifecycle hooks. */
export interface PluginContext {
    /** Read the latest mixer snapshot (decks, crossfader, master, meters). */
    getState(): MixerState | null;
    /** Subscribe to the ~30 Hz mixer state stream. Returns an unsubscribe fn. */
    subscribe(listener: (state: MixerState) => void): () => void;
    /** Curated, safe transport/mix controls. */
    engine: PluginEngine;
    /** Surface a short, non-blocking message to the user (host renders it). */
    notify(message: string): void;
    /** Persist a small JSON-serialisable settings blob for this plugin. */
    saveSettings(data: unknown): void;
    /** Read this plugin's persisted settings blob (or null). */
    loadSettings<T = unknown>(): T | null;
}

/** Props handed to a plugin's panel component. */
export interface PluginPanelProps {
    ctx: PluginContext;
    /** Plugin's accent color token (inherits the active theme). */
    accent: string;
}

/** The plugin definition itself. Pure data + a component + optional hooks. */
export interface MixaiPlugin {
    /** Stable unique id, e.g. `"mixai.beat-strobe"`. Reverse-DNS encouraged. */
    id: string;
    /** Human-readable name shown in the manager + panel header. */
    name: string;
    /** One-line description. */
    description: string;
    /** SemVer string of the plugin. */
    version: string;
    /** Author / vendor label. */
    author: string;
    category: PluginCategory;
    /** A short emoji/glyph used as the plugin's icon in the manager. */
    icon: string;
    /** Whether this plugin renders a dock panel. */
    hasPanel: boolean;
    /** The panel component (required when `hasPanel`). */
    Panel?: (props: PluginPanelProps) => ReactNode;
    /** Called once when the plugin is enabled (after activation). */
    onEnable?(ctx: PluginContext): void;
    /** Called once when the plugin is disabled (cleanup subscriptions etc.). */
    onDisable?(ctx: PluginContext): void;
}

/** SDK version — bump when the contract changes in a breaking way. Plugins can
 *  declare the range they support so the host can refuse incompatible ones. */
export const PLUGIN_SDK_VERSION = "1.0.0" as const;

/** Type guard used by the loader to validate an externally-provided object
 *  before trusting it as a plugin. Keeps the registry from crashing on a
 *  malformed third-party module. */
export function isValidPlugin(value: unknown): value is MixaiPlugin {
    if (!value || typeof value !== "object") return false;
    const p = value as Partial<MixaiPlugin>;
    const stringOk = (v: unknown) => typeof v === "string" && v.length > 0;
    if (!stringOk(p.id) || !stringOk(p.name) || !stringOk(p.version)) return false;
    if (!stringOk(p.description) || !stringOk(p.author) || !stringOk(p.icon)) return false;
    if (p.category !== "effect" && p.category !== "visual" && p.category !== "assistant" && p.category !== "utility") {
        return false;
    }
    if (typeof p.hasPanel !== "boolean") return false;
    if (p.hasPanel && typeof p.Panel !== "function") return false;
    return true;
}
