/**
 * UI-only state: theme, deck count, panel visibility. Persisted to
 * localStorage now; will sync to the muzicai.ro account later.
 */

import { create } from "zustand";
import {
    applyTheme,
    applyThemeDef,
    blankCustomTheme,
    importTheme as parseTheme,
    isCustomThemeId,
    makeCustomTheme,
    THEMES,
    type CustomTheme,
    type ThemeId,
} from "@/themes/themes";

const STORAGE_KEY = "mixai-ui";

/** A theme id is either a built-in `ThemeId` or a `custom:<uuid>` string. */
type AnyThemeId = ThemeId | `custom:${string}`;

interface PersistedUi {
    theme: AnyThemeId;
    deckCount: 2 | 4;
    customThemes: CustomTheme[];
}

function load(): PersistedUi {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { theme: "neon-glass", deckCount: 2, customThemes: [], ...JSON.parse(raw) };
    } catch {
        // ignore corrupt storage
    }
    return { theme: "neon-glass", deckCount: 2, customThemes: [] };
}

function persist(ui: PersistedUi): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ui));
    } catch {
        // storage may be unavailable; non-fatal
    }
}

interface UiStore extends PersistedUi {
    settingsOpen: boolean;
    shortcutsOpen: boolean;
    setTheme: (theme: AnyThemeId) => void;
    setDeckCount: (n: 2 | 4) => void;
    setSettingsOpen: (open: boolean) => void;
    setShortcutsOpen: (open: boolean) => void;
    /** Create a new custom theme (cloned from Neon Glass) and select it. */
    addCustomTheme: (name: string) => void;
    /** Patch a single editable color token on a custom theme. */
    updateCustomThemeColor: (id: string, key: string, value: string) => void;
    /** Rename a custom theme. */
    renameCustomTheme: (id: string, name: string) => void;
    /** Delete a custom theme (falls back to Neon Glass if it was active). */
    deleteCustomTheme: (id: string) => void;
    /** Import a shared theme JSON string; returns false when malformed. */
    importThemeString: (json: string) => boolean;
    /** (Re)apply the currently-selected theme (built-in or custom) to the DOM. */
    applyActiveTheme: () => void;
    /**
     * Restore theme-related preferences from a profile backup. Missing fields
     * are left untouched. Custom themes are merged by id (imported wins).
     */
    restoreProfile: (patch: {
        theme?: AnyThemeId;
        deckCount?: 2 | 4;
        customThemes?: CustomTheme[];
    }) => void;
}

const initial = load();

/** Resolve a theme id to its definition (built-in or custom). */
function resolveTheme(id: AnyThemeId, custom: CustomTheme[]): CustomTheme | (typeof THEMES)[ThemeId] {
    if (isCustomThemeId(id)) {
        return custom.find((t) => t.id === id) ?? THEMES["neon-glass"];
    }
    return THEMES[id as ThemeId] ?? THEMES["neon-glass"];
}

function newId(): `custom:${string}` {
    const rnd =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2);
    return `custom:${rnd}`;
}

export const useUiStore = create<UiStore>((set, get) => ({
    ...initial,
    settingsOpen: false,
    shortcutsOpen: false,
    setTheme: (theme) => {
        applyThemeDef(resolveTheme(theme, get().customThemes));
        set({ theme });
        persist({ theme, deckCount: get().deckCount, customThemes: get().customThemes });
    },
    setDeckCount: (deckCount) => {
        set({ deckCount });
        persist({ theme: get().theme, deckCount, customThemes: get().customThemes });
    },
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

    addCustomTheme: (name) => {
        const id = newId();
        const theme = blankCustomTheme(id, name.trim() || "My Theme");
        const customThemes = [...get().customThemes, theme];
        applyThemeDef(theme);
        set({ customThemes, theme: id });
        persist({ theme: id, deckCount: get().deckCount, customThemes });
    },

    updateCustomThemeColor: (id, key, value) => {
        const customThemes = get().customThemes.map((t) => {
            if (t.id !== id) return t;
            const colors: Record<string, string> = {};
            for (const [k, v] of Object.entries(t.tokens)) colors[k] = v;
            colors[key] = value;
            return makeCustomTheme(t.id, t.name, t.motion, colors);
        });
        set({ customThemes });
        if (get().theme === id) {
            const updated = customThemes.find((t) => t.id === id);
            if (updated) applyThemeDef(updated);
        }
        persist({ theme: get().theme, deckCount: get().deckCount, customThemes });
    },

    renameCustomTheme: (id, name) => {
        const customThemes = get().customThemes.map((t) =>
            t.id === id ? { ...t, name: name.trim() || t.name } : t,
        );
        set({ customThemes });
        persist({ theme: get().theme, deckCount: get().deckCount, customThemes });
    },

    deleteCustomTheme: (id) => {
        const customThemes = get().customThemes.filter((t) => t.id !== id);
        const wasActive = get().theme === id;
        const theme: AnyThemeId = wasActive ? "neon-glass" : get().theme;
        if (wasActive) applyTheme("neon-glass");
        set({ customThemes, theme });
        persist({ theme, deckCount: get().deckCount, customThemes });
    },

    importThemeString: (json) => {
        const id = newId();
        const theme = parseTheme(json, id);
        if (!theme) return false;
        const customThemes = [...get().customThemes, theme];
        applyThemeDef(theme);
        set({ customThemes, theme: id });
        persist({ theme: id, deckCount: get().deckCount, customThemes });
        return true;
    },

    applyActiveTheme: () => {
        applyThemeDef(resolveTheme(get().theme, get().customThemes));
    },

    restoreProfile: (patch) => {
        // Merge custom themes by id (imported entries override existing).
        const existing = get().customThemes;
        const merged = patch.customThemes
            ? [
                  ...existing.filter((t) => !patch.customThemes!.some((p) => p.id === t.id)),
                  ...patch.customThemes,
              ]
            : existing;
        const deckCount = patch.deckCount ?? get().deckCount;
        const theme = patch.theme ?? get().theme;
        set({ customThemes: merged, deckCount, theme });
        applyThemeDef(resolveTheme(theme, merged));
        persist({ theme, deckCount, customThemes: merged });
    },
}));
