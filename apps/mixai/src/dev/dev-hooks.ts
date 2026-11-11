/**
 * Development-only handle on the app (`window.__decks`), loaded by main.tsx behind
 * `import.meta.env.DEV`, so it is not part of a production bundle. Lets a remote debugger
 * (CDP) drive the real UI paths: load a local file through the same loader the library uses,
 * read the stores, switch layout / skin.
 */
import { loadLibraryTrack } from "@/lib/load-track";
import { useMixerStore } from "@/state/mixer-store";
import { useWaveStore } from "@/state/wave-store";
import { usePerfStore } from "@/state/perf-store";
import { useLayoutStore } from "@/layout/layout-store";
import { usePanelLab } from "@/layout/panel-lab";
import { PANEL_SPECS } from "@/layout/presets";
import type { PanelId, Tier } from "@/layout/types";
import { useHistoryStore } from "@/state/history-store";
import { useSkinEditor } from "@/settings/SkinEditor";
import { useDeckUi } from "@/components/deck-ui-store";
import type { DeckTab } from "@/components/deck-ui-store";
import { mountTabLab, useTabLab } from "./tab-lab";
import { usePackStore } from "@/packs/pack-store";
import { useShellPrefs } from "@/shell/shell-prefs";
import { useUiStore } from "@/state/ui-store";
import { useCompanionStore } from "@/state/companion-store";
import { engine } from "@/bridge/engine";
import type { DeckId, LibraryTrack } from "@/bridge/types";

let nextId = 900_000;

const dev = {
    engine,
    mixer: useMixerStore,
    waves: useWaveStore,
    perf: usePerfStore,
    layout: useLayoutStore,
    packs: usePackStore,
    shell: useShellPrefs,
    ui: useUiStore,
    companion: useCompanionStore,
    history: useHistoryStore,
    skinEditor: useSkinEditor,
    /** Per-deck UI state (active tab: "cues" | "loops" | "fx" | "stems" | "grid", cue point). */
    deckUi: useDeckUi,
    /**
     * Tab lab: render one deck tab body alone in a `w`×`h` px box at the bottom-right corner
     * (id `tab-lab`), whatever the deck's own layout is. `tabLab()` removes it.
     */
    tabLab(deck?: DeckId, tab: DeckTab = "cues", w = 464, h = 60, compact = false): string {
        mountTabLab();
        if (!deck) {
            useTabLab.getState().set(null);
            return "tab lab off";
        }
        useTabLab.getState().set({ deck, tab, w, h, compact });
        return `tab lab ${deck}/${tab} ${w}x${h}${compact ? " compact" : ""}`;
    },
    /**
     * Panel lab: show `panel` at tier `tier` in a box of `w`×`h` px (default: that tier's
     * minimum size) at its usual top-left corner; `lab(panel)` puts it back. Returns the box.
     */
    lab(panel: PanelId, tier?: Tier, w?: number, h?: number): string {
        if (!tier) {
            usePanelLab.getState().set(panel, null);
            return `${panel}: lab off`;
        }
        const min = PANEL_SPECS[panel].min[tier];
        const box = { tier, w: w ?? min.w, h: h ?? min.h };
        usePanelLab.getState().set(panel, box);
        return `${panel}: lab ${tier} ${box.w}x${box.h} (min ${min.w}x${min.h})`;
    },
    /** Load a local audio file onto a deck exactly like a library row would. */
    async load(deck: DeckId, filepath: string, meta: Partial<Pick<LibraryTrack, "title" | "artist" | "bpm" | "keyCamelot">> = {}): Promise<string> {
        const filename = filepath.split(/[\\/]/).pop() ?? filepath;
        const track: LibraryTrack = {
            id: nextId++,
            filepath,
            filename,
            artist: meta.artist ?? null,
            title: meta.title ?? filename.replace(/\.[a-z0-9]+$/i, ""),
            bpm: meta.bpm ?? null,
            keyCamelot: meta.keyCamelot ?? null,
            duration: null,
            genre: null,
            isFavorite: null,
            rating: null,
            stemsStatus: null,
        };
        await loadLibraryTrack(deck, track);
        const d = useMixerStore.getState().deck(deck);
        return `${deck}: loaded=${d.loaded} dur=${d.duration.toFixed(1)} bpm=${d.bpm.toFixed(2)} peaks=${useMixerStore.getState().waveforms[deck].length}`;
    },
};

declare global {
    interface Window {
        __decks?: typeof dev;
    }
}

window.__decks = dev;

// Opt-in (localStorage "mixai-dev-no-overlay" = "1"): drop Vite's full-screen error overlay as
// soon as it appears. With several people editing different panels at once, one module with a
// syntax error would otherwise cover everybody's app; the last good version keeps running and
// the error stays in the Vite terminal and the console.
try {
    if (localStorage.getItem("mixai-dev-no-overlay") === "1") {
        new MutationObserver(() => {
            for (const el of document.querySelectorAll("vite-error-overlay")) el.remove();
        }).observe(document.body, { childList: true });
    }
} catch {
    // storage unavailable
}
