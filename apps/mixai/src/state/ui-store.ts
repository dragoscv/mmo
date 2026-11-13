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
import { gigAllows } from "@/gig/gig-store";

const STORAGE_KEY = "mixai-ui";

export type DeckCount = 2 | 4;

/** Settings modal tabs (vertical, left). Order = display order. */
export const SETTINGS_TABS = [
    "appearance",
    "layout",
    "audio",
    "controllers",
    "keyboard",
    "library",
    "plugins",
    "marketplace",
    "profiles",
    "about",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

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
    /** Active settings tab (kept while the modal is closed). */
    settingsTab: SettingsTab;
    shortcutsOpen: boolean;
    commandOpen: boolean;
    /** Stage mode: only decks + mixer, big waveforms (not persisted). */
    stage: boolean;
    setDeckCount: (n: DeckCount) => void;
    setSettingsOpen: (open: boolean) => void;
    /** Open the settings modal on a tab. */
    openSettings: (tab?: SettingsTab) => void;
    setSettingsTab: (tab: SettingsTab) => void;
    setShortcutsOpen: (open: boolean) => void;
    setCommandOpen: (open: boolean) => void;
    setStage: (on: boolean) => void;
    /** Restore layout preferences from a profile backup. */
    restoreProfile: (patch: { deckCount?: DeckCount }) => void;
}

export const useUiStore = create<UiStore>((set, get) => ({
    ...load(),
    settingsOpen: false,
    settingsTab: "appearance",
    shortcutsOpen: false,
    commandOpen: false,
    stage: false,
    setDeckCount: (deckCount) => {
        set({ deckCount });
        persist({ deckCount });
    },
    // Gig lock: every way of opening Settings ends here. Refused while locked (the gate says
    // why in the status region); closing is always allowed.
    setSettingsOpen: (settingsOpen) => {
        if (settingsOpen && !gigAllows("openSettings")) return;
        set({ settingsOpen });
    },
    openSettings: (tab) => {
        if (!gigAllows("openSettings")) return;
        set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab }));
    },
    setSettingsTab: (settingsTab) => set({ settingsTab }),
    setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
    setCommandOpen: (commandOpen) => set({ commandOpen }),
    setStage: (stage) => set({ stage }),
    restoreProfile: (patch) => {
        const deckCount = patch.deckCount ?? get().deckCount;
        set({ deckCount });
        persist({ deckCount });
    },
}));
