import type { DockviewApi } from "dockview";

// Lightweight module shared by the toolbar / panel manager and the (lazily
// loaded) dockview widget. Keeping these here lets `daw-dockview.tsx` — and
// with it the whole `dockview` package — be code-split via next/dynamic
// without the consumers of `getDockviewApi()` pulling it back into the
// route's first-load bundle. Only types are imported from `dockview`.

export const LAYOUT_STORAGE_KEY = "daw_dockview_layout";

// Module-level API reference for external access
let _dockviewApi: DockviewApi | null = null;

/** Get the current dockview API instance (or null if not mounted) */
export function getDockviewApi(): DockviewApi | null {
    return _dockviewApi;
}

/** @internal set by DAWDockview on ready / cleared on unmount */
export function setDockviewApi(api: DockviewApi | null): void {
    _dockviewApi = api;
}

// Panel IDs
export const PANEL_IDS = {
    timeline: "panel_timeline",
    browser: "panel_browser",
    mixer: "panel_mixer",
    pianoRoll: "panel_piano_roll",
    stepSequencer: "panel_step_sequencer",
    effectsRack: "panel_effects_rack",
    synthesizer: "panel_synthesizer",
    history: "panel_history",
    clipboard: "panel_clipboard",
    voiceProcessor: "panel_voice_processor",
} as const;

export function resetDockviewLayout() {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    window.location.reload();
}
