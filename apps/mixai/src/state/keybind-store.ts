/**
 * User keybind overrides.
 *
 * Core deck/mixer shortcuts ship with sensible defaults (see `lib/shortcuts`),
 * but DJs each have muscle memory. This store keeps a small map of
 * `shortcutId → KeyboardEvent.code` overrides, persisted to localStorage and
 * (via the profile) synced to the account. The live key handler resolves the
 * effective code→action map from defaults + overrides, so a remapped key wins
 * and the original key is freed.
 */

import { create } from "zustand";
import {
    ALL_SHORTCUTS,
    SHORTCUTS_BY_ID,
    shortcutId,
    type Shortcut,
} from "@/lib/shortcuts";

const STORAGE_KEY = "mixai-keybinds";

/** Map of stable shortcut id → overridden `KeyboardEvent.code`. */
export type KeybindOverrides = Record<string, string>;

function isValidOverrides(v: unknown): v is KeybindOverrides {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val !== "string" || !val) return false;
        // Drop ids we don't recognise (stale after a defaults change).
        if (!SHORTCUTS_BY_ID.has(k)) return false;
    }
    return true;
}

function load(): KeybindOverrides {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        return isValidOverrides(parsed) ? parsed : sanitize(parsed);
    } catch {
        return {};
    }
}

/** Keep only the recognised, string-valued entries from an untrusted blob. */
function sanitize(v: unknown): KeybindOverrides {
    const out: KeybindOverrides = {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && val && SHORTCUTS_BY_ID.has(k)) out[k] = val;
    }
    return out;
}

function persist(overrides: KeybindOverrides): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
        /* non-fatal */
    }
}

/** Resolve the effective `code → Shortcut` map from defaults + overrides.
 *  An override moves a binding to a new code; if two bindings land on the same
 *  code, the override wins (later assignment overwrites). */
export function resolveBindings(overrides: KeybindOverrides): Map<string, Shortcut> {
    const map = new Map<string, Shortcut>();
    for (const s of ALL_SHORTCUTS) {
        const code = overrides[shortcutId(s)] ?? s.code;
        map.set(code, { ...s, code });
    }
    return map;
}

interface KeybindStore {
    overrides: KeybindOverrides;
    /** Effective code→Shortcut map (recomputed on every change). */
    bindings: Map<string, Shortcut>;
    /** Remap a shortcut (by id) to a new `KeyboardEvent.code`. */
    rebind: (id: string, code: string) => void;
    /** Clear one override, reverting to its default key. */
    reset: (id: string) => void;
    /** Clear all overrides. */
    resetAll: () => void;
    /** Replace overrides wholesale (used by profile restore). */
    setOverrides: (overrides: KeybindOverrides) => void;
}

const initial = load();

export const useKeybindStore = create<KeybindStore>((set, get) => ({
    overrides: initial,
    bindings: resolveBindings(initial),

    rebind: (id, code) => {
        if (!SHORTCUTS_BY_ID.has(id) || !code) return;
        const overrides = { ...get().overrides, [id]: code };
        set({ overrides, bindings: resolveBindings(overrides) });
        persist(overrides);
    },

    reset: (id) => {
        if (!(id in get().overrides)) return;
        const overrides = { ...get().overrides };
        delete overrides[id];
        set({ overrides, bindings: resolveBindings(overrides) });
        persist(overrides);
    },

    resetAll: () => {
        set({ overrides: {}, bindings: resolveBindings({}) });
        persist({});
    },

    setOverrides: (raw) => {
        const overrides = sanitize(raw);
        set({ overrides, bindings: resolveBindings(overrides) });
        persist(overrides);
    },
}));
