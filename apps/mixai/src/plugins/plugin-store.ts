/**
 * Plugin registry + activation state.
 *
 * Holds the list of registered plugins (built-ins for now), the set of enabled
 * plugin ids (persisted to localStorage), and builds the shared
 * {@link PluginContext} that every plugin receives. The context is the ONLY
 * way a plugin reaches the engine / mixer state, which keeps plugins decoupled
 * from the app internals and ready to sandbox later.
 */

import { create } from "zustand";
import { engine } from "@/bridge/engine";
import { subscribeMixerState } from "@/bridge/events";
import { useMixerStore } from "@/state/mixer-store";
import type { MixerState } from "@/bridge/types";
import { BUILTIN_PLUGINS } from "./builtins";
import type { MixaiPlugin, PluginContext } from "./sdk";
import { isValidPlugin } from "./sdk";
import {
    compileExternalPlugin,
    parseExternalSpec,
    type ExternalPluginSpec,
} from "./external";

const STORAGE_KEY = "mixai-plugins";
const EXTERNAL_KEY = "mixai-external-plugins";

/** Load persisted external plugin specs (declarative). */
function loadExternalSpecs(): ExternalPluginSpec[] {
    try {
        const raw = localStorage.getItem(EXTERNAL_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        // Re-validate each through the parser so a tampered store can't inject junk.
        return parsed
            .map((s) => parseExternalSpec(JSON.stringify(s)))
            .filter((s): s is ExternalPluginSpec => s !== null);
    } catch {
        return [];
    }
}

function persistExternalSpecs(specs: ExternalPluginSpec[]): void {
    try {
        localStorage.setItem(EXTERNAL_KEY, JSON.stringify(specs));
    } catch {
        /* non-fatal */
    }
}

/** Compile persisted specs into plugins, keeping only valid ones. */
function loadExternalPlugins(): MixaiPlugin[] {
    return loadExternalSpecs()
        .map(compileExternalPlugin)
        .filter(isValidPlugin);
}

function loadEnabled(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
        }
    } catch {
        // ignore corrupt storage
    }
    return [];
}

function persistEnabled(ids: string[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
        // storage may be unavailable; non-fatal
    }
}

// ── Per-plugin settings persistence ──────────────────────────────────────────
function settingsKey(id: string): string {
    return `mixai-plugin:${id}`;
}
function savePluginSettings(id: string, data: unknown): void {
    try {
        localStorage.setItem(settingsKey(id), JSON.stringify(data));
    } catch {
        /* non-fatal */
    }
}
function loadPluginSettings<T>(id: string): T | null {
    try {
        const raw = localStorage.getItem(settingsKey(id));
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

// ── Shared 30 Hz fan-out ──────────────────────────────────────────────────────
//
// We subscribe to the core's `mixer://state` ONCE and fan out to every plugin
// listener, rather than have each plugin open its own Tauri listener. Plugins
// also fall back to the zustand mixer store (kept in sync by App.tsx) so they
// work even before the dedicated subscription attaches and in design mode.
const stateListeners = new Set<(s: MixerState) => void>();
let unlistenState: (() => void) | null = null;

function ensureStateBridge(): void {
    if (unlistenState || stateListeners.size === 0) return;
    void subscribeMixerState((s) => {
        for (const l of Array.from(stateListeners)) {
            try {
                l(s);
            } catch {
                /* a misbehaving plugin must not break the fan-out */
            }
        }
    }).then((un) => {
        unlistenState = un;
    });
}

/** The single PluginContext shared by all plugins (stateless except for the
 *  per-plugin settings namespace, which is bound in `contextFor`). */
function contextFor(pluginId: string): PluginContext {
    return {
        getState: () => {
            const m = useMixerStore.getState();
            // Reconstruct a MixerState-shaped object from the store mirror.
            return {
                crossfader: m.crossfader,
                crossfaderCurve: m.crossfaderCurve,
                masterVolume: m.masterVolume,
                cueVolume: m.cueVolume,
                masterVu: m.masterVu,
                decks: m.decks,
                sampleRate: m.sampleRate,
                latencyMs: m.latencyMs,
            };
        },
        subscribe: (listener) => {
            stateListeners.add(listener);
            ensureStateBridge();
            return () => {
                stateListeners.delete(listener);
                if (stateListeners.size === 0 && unlistenState) {
                    unlistenState();
                    unlistenState = null;
                }
            };
        },
        engine: {
            play: (deck) => void engine.play(deck),
            pause: (deck) => void engine.pause(deck),
            setVolume: (deck, v) => void engine.setVolume(deck, v),
            setEq: (deck, band, db) => void engine.setEq(deck, band, db),
            setFilter: (deck, v) => void engine.setFilter(deck, v),
            setCrossfader: (v) => void engine.setCrossfader(v),
            sync: (deck) => void engine.sync(deck),
            setFxKind: (deck, kind) => void engine.setFxKind(deck, kind),
            setFxWet: (deck, wet) => void engine.setFxWet(deck, wet),
            setFxBeats: (deck, beats) => void engine.setFxBeats(deck, beats),
        },
        notify: (message) => usePluginStore.getState().pushToast(message),
        saveSettings: (data) => savePluginSettings(pluginId, data),
        loadSettings: <T,>() => loadPluginSettings<T>(pluginId),
    };
}

interface PluginToast {
    id: number;
    message: string;
}

interface PluginStore {
    /** All registered plugins (built-ins + any future loaded externals). */
    plugins: MixaiPlugin[];
    /** Persisted declarative external plugin specs. */
    externalSpecs: ExternalPluginSpec[];
    /** Ids of currently-enabled plugins. */
    enabled: string[];
    /** Transient toasts raised by plugins via `ctx.notify`. */
    toasts: PluginToast[];
    isEnabled: (id: string) => boolean;
    enable: (id: string) => void;
    disable: (id: string) => void;
    toggle: (id: string) => void;
    /** Install a declarative plugin from a shared JSON spec. Returns an error
     *  message, or null on success. */
    installExternal: (json: string) => string | null;
    /** Remove an installed external plugin by id. */
    removeExternal: (id: string) => void;
    /** True when the plugin id is an installed external (not a built-in). */
    isExternal: (id: string) => boolean;
    /** Get (memo-free) the shared context for a plugin. */
    contextFor: (id: string) => PluginContext;
    pushToast: (message: string) => void;
    dismissToast: (id: number) => void;
}

let toastSeq = 0;

const initialExternalSpecs = loadExternalSpecs();
const initialExternalPlugins = loadExternalPlugins();
const initialPlugins = [...BUILTIN_PLUGINS, ...initialExternalPlugins];

export const usePluginStore = create<PluginStore>((set, get) => ({
    plugins: initialPlugins,
    externalSpecs: initialExternalSpecs,
    enabled: loadEnabled().filter((id) => initialPlugins.some((p) => p.id === id)),
    toasts: [],

    isEnabled: (id) => get().enabled.includes(id),

    enable: (id) => {
        if (get().enabled.includes(id)) return;
        const plugin = get().plugins.find((p) => p.id === id);
        const next = [...get().enabled, id];
        set({ enabled: next });
        persistEnabled(next);
        plugin?.onEnable?.(contextFor(id));
    },

    disable: (id) => {
        if (!get().enabled.includes(id)) return;
        const plugin = get().plugins.find((p) => p.id === id);
        plugin?.onDisable?.(contextFor(id));
        const next = get().enabled.filter((x) => x !== id);
        set({ enabled: next });
        persistEnabled(next);
    },

    toggle: (id) => {
        if (get().isEnabled(id)) get().disable(id);
        else get().enable(id);
    },

    installExternal: (json) => {
        const spec = parseExternalSpec(json);
        if (!spec) return "Couldn't parse that plugin.";
        const plugin = compileExternalPlugin(spec);
        if (!isValidPlugin(plugin)) return "Plugin failed validation.";
        if (BUILTIN_PLUGINS.some((p) => p.id === spec.id)) {
            return "That id collides with a built-in plugin.";
        }
        // Replace any existing external with the same id (upsert).
        const specs = [...get().externalSpecs.filter((s) => s.id !== spec.id), spec];
        const externals = specs.map(compileExternalPlugin);
        persistExternalSpecs(specs);
        set({ externalSpecs: specs, plugins: [...BUILTIN_PLUGINS, ...externals] });
        return null;
    },

    removeExternal: (id) => {
        if (get().isEnabled(id)) get().disable(id);
        const specs = get().externalSpecs.filter((s) => s.id !== id);
        const externals = specs.map(compileExternalPlugin);
        persistExternalSpecs(specs);
        set({ externalSpecs: specs, plugins: [...BUILTIN_PLUGINS, ...externals] });
    },

    isExternal: (id) => get().externalSpecs.some((s) => s.id === id),

    contextFor: (id) => contextFor(id),

    pushToast: (message) => {
        const toast = { id: ++toastSeq, message };
        set({ toasts: [...get().toasts, toast] });
        setTimeout(() => get().dismissToast(toast.id), 3200);
    },

    dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
