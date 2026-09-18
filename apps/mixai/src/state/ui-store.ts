/**
 * UI-only state: deck count, panel visibility. Persisted to localStorage and
 * synced to the mixai.ro account via the profile blob.
 *
 * Appearance (mode / accent / surface / density / radius / motion / locale) is
 * NOT here any more — it lives in the shared `@mmo/ui` ThemeProvider
 * (`mixai:prefs:v1`). The old `theme` field of this blob (`neon-glass` /
 * `studio-metal` / `flat-pro`) is migrated once by @mmo/ui's prefs-store into
 * a `surface` preset (glass / solid / flat).
 */

import { create } from "zustand";

const STORAGE_KEY = "mixai-ui";

export type DeckCount = 2 | 4;

interface PersistedUi {
    deckCount: DeckCount;
}

function load(): PersistedUi {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<PersistedUi>;
            return { deckCount: parsed.deckCount === 4 ? 4 : 2 };
        }
    } catch {
        // ignore corrupt storage
    }
    return { deckCount: 2 };
}

function persist(ui: PersistedUi): void {
    try {
        // Merge so the legacy `theme` key survives until prefs migration has run.
        const prev = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, ...ui }));
    } catch {
        // storage may be unavailable; non-fatal
    }
}

interface UiStore extends PersistedUi {
    settingsOpen: boolean;
    shortcutsOpen: boolean;
    commandOpen: boolean;
    setDeckCount: (n: DeckCount) => void;
    setSettingsOpen: (open: boolean) => void;
    setShortcutsOpen: (open: boolean) => void;
    setCommandOpen: (open: boolean) => void;
    /** Restore layout preferences from a profile backup. */
    restoreProfile: (patch: { deckCount?: DeckCount }) => void;
}

export const useUiStore = create<UiStore>((set, get) => ({
    ...load(),
    settingsOpen: false,
    shortcutsOpen: false,
    commandOpen: false,
    setDeckCount: (deckCount) => {
        set({ deckCount });
        persist({ deckCount });
    },
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    setCommandOpen: (commandOpen) => set({ commandOpen }),
    restoreProfile: (patch) => {
        const deckCount = patch.deckCount ?? get().deckCount;
        set({ deckCount });
        persist({ deckCount });
    },
}));
