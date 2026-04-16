"use client";

import {
    DockviewReact,
    type DockviewReadyEvent,
    type DockviewApi,
    type IDockviewPanelProps,
    type IDockviewPanelHeaderProps,
    type SerializedDockview,
    type DockviewTheme,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { DAWTimeline } from "./daw-timeline";
import { DAWMixer } from "./daw-mixer";
import { DAWPianoRoll } from "./daw-piano-roll";
import { DAWStepSequencer } from "./daw-step-sequencer";
import { DAWBrowser } from "./daw-browser";
import { DAWEffectsRack } from "./daw-effects-rack";
import { DAWSynthesizer } from "./daw-synthesizer";
import { HistoryPanel } from "./daw-history-panel";
import { ClipboardPanel } from "./daw-clipboard-panel";
import { useDAWActions, useDAWState } from "./daw-context";
import { useContextMenu, type MenuEntry } from "./daw-context-menu";
import {
    Maximize2, Minimize2, PanelTop, PanelBottom, X,
    Columns2, Copy, ExternalLink,
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const LAYOUT_STORAGE_KEY = "daw_dockview_layout";
const SAVE_DEBOUNCE_MS = 500;

// Module-level API reference for external access
let _dockviewApi: DockviewApi | null = null;

/** Get the current dockview API instance (or null if not mounted) */
export function getDockviewApi(): DockviewApi | null {
    return _dockviewApi;
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
} as const;

// Panel metadata
const PANEL_META: Record<string, { title: string; component: string; shortcut: string }> = {
    [PANEL_IDS.timeline]: { title: "Timeline", component: "timeline", shortcut: "—" },
    [PANEL_IDS.browser]: { title: "Browser", component: "browser", shortcut: "F1" },
    [PANEL_IDS.mixer]: { title: "Mixer", component: "mixer", shortcut: "F2" },
    [PANEL_IDS.pianoRoll]: { title: "Piano Roll", component: "pianoRoll", shortcut: "F3" },
    [PANEL_IDS.stepSequencer]: { title: "Step Sequencer", component: "stepSequencer", shortcut: "F4" },
    [PANEL_IDS.effectsRack]: { title: "Effects Rack", component: "effectsRack", shortcut: "F5" },
    [PANEL_IDS.synthesizer]: { title: "Synthesizer", component: "synthesizer", shortcut: "F6" },
    [PANEL_IDS.history]: { title: "History", component: "history", shortcut: "F8" },
    [PANEL_IDS.clipboard]: { title: "Clipboard", component: "clipboard", shortcut: "F9" },
};

// ═══════════════════════════════════════════════════════════════════════════
// Custom Tab with Context Menu
// ═══════════════════════════════════════════════════════════════════════════

function DAWTab({ api, containerApi }: IDockviewPanelHeaderProps) {
    const [title, setTitle] = useState(api.title ?? "");
    const ctxMenu = useContextMenu();

    useEffect(() => {
        const d = api.onDidTitleChange(e => setTitle(e.title));
        if (title !== api.title) setTitle(api.title ?? "");
        return () => d.dispose();
    }, [api]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const isFloating = api.location.type === "floating";
        const isMaximized = api.isMaximized();

        const items: MenuEntry[] = [
            { type: "label", label: title },
            { type: "separator" },
            {
                label: isMaximized ? "Restore Size" : "Maximize",
                icon: isMaximized
                    ? <Minimize2 className="h-3.5 w-3.5" />
                    : <Maximize2 className="h-3.5 w-3.5" />,
                onClick: () => isMaximized ? api.exitMaximized() : api.maximize(),
            },
            {
                label: isFloating ? "Dock Panel" : "Float Panel",
                icon: isFloating
                    ? <PanelBottom className="h-3.5 w-3.5" />
                    : <PanelTop className="h-3.5 w-3.5" />,
                onClick: () => {
                    if (isFloating) {
                        // Move back to main grid — dock next to timeline
                        const timelinePanel = containerApi.getPanel(PANEL_IDS.timeline);
                        if (timelinePanel) {
                            api.moveTo({ group: timelinePanel.group, position: "center" });
                        }
                    } else {
                        // Float: get panel object and pass to addFloatingGroup
                        const panel = containerApi.getPanel(api.id);
                        if (panel) {
                            containerApi.addFloatingGroup(panel, {
                                width: 500,
                                height: 400,
                            });
                        }
                    }
                },
            },
            { type: "separator" },
            {
                label: "Split Right",
                icon: <Columns2 className="h-3.5 w-3.5" />,
                disabled: !containerApi.getPanel(PANEL_IDS.timeline),
                onClick: () => {
                    const ref = containerApi.getPanel(PANEL_IDS.timeline);
                    if (ref) api.moveTo({ group: ref.group, position: "right" });
                },
            },
            {
                label: "Split Down",
                icon: <PanelBottom className="h-3.5 w-3.5" />,
                disabled: !containerApi.getPanel(PANEL_IDS.timeline),
                onClick: () => {
                    const ref = containerApi.getPanel(PANEL_IDS.timeline);
                    if (ref) api.moveTo({ group: ref.group, position: "bottom" });
                },
            },
            { type: "separator" },
            {
                label: "Close Panel",
                icon: <X className="h-3.5 w-3.5" />,
                shortcut: PANEL_META[api.id]?.shortcut,
                destructive: api.id !== PANEL_IDS.timeline,
                disabled: api.id === PANEL_IDS.timeline,
                onClick: () => api.close(),
            },
        ];

        ctxMenu.show(e.clientX, e.clientY, items);
    }, [api, containerApi, ctxMenu, title]);

    return (
        <div
            className="dv-default-tab"
            onContextMenu={handleContextMenu}
        >
            <span className="dv-default-tab-content">{title}</span>
            {api.id !== PANEL_IDS.timeline && (
                <div
                    className="dv-default-tab-action"
                    onPointerDown={e => e.preventDefault()}
                    onClick={e => { e.preventDefault(); api.close(); }}
                >
                    <svg width="11" height="11" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M2 2L26 26M26 2L2 26" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Panel Components (wrappers for dockview)
// ═══════════════════════════════════════════════════════════════════════════

function TimelinePanel(_props: IDockviewPanelProps) {
    return (
        <div className="h-full w-full overflow-hidden">
            <DAWTimeline />
        </div>
    );
}

function BrowserPanel(_props: IDockviewPanelProps) {
    return (
        <div className="h-full w-full overflow-hidden">
            <DAWBrowser />
        </div>
    );
}

function MixerPanel(_props: IDockviewPanelProps) {
    return (
        <div className="h-full w-full overflow-hidden">
            <DAWMixer />
        </div>
    );
}

function PianoRollPanel(_props: IDockviewPanelProps) {
    return (
        <div className="h-full w-full overflow-hidden">
            <DAWPianoRoll />
        </div>
    );
}

function StepSequencerPanel(_props: IDockviewPanelProps) {
    return (
        <div className="h-full w-full overflow-hidden">
            <DAWStepSequencer />
        </div>
    );
}

function EffectsRackPanel(_props: IDockviewPanelProps) {
    return (
        <div className="h-full w-full overflow-hidden">
            <DAWEffectsRack />
        </div>
    );
}

function SynthesizerPanel(_props: IDockviewPanelProps) {
    return (
        <div className="h-full w-full overflow-hidden">
            <DAWSynthesizer />
        </div>
    );
}

function HistoryPanelWrapper(_props: IDockviewPanelProps) {
    const dawState = useDAWState();
    const dawActions = useDAWActions();
    return (
        <div className="h-full w-full overflow-hidden">
            <HistoryPanel
                history={dawState.history}
                onUndo={dawActions.undo}
                onRedo={dawActions.redo}
                onJump={dawActions.jumpToHistoryEntry}
            />
        </div>
    );
}

function ClipboardPanelWrapper(_props: IDockviewPanelProps) {
    const dawState = useDAWState();
    const dawActions = useDAWActions();
    return (
        <div className="h-full w-full overflow-hidden">
            <ClipboardPanel
                clipboard={dawState.clipboard}
                onSetActive={dawActions.setActiveClipboardEntry}
                onRemove={dawActions.removeClipboardEntry}
                onTogglePin={dawActions.togglePinClipboardEntry}
                onClear={dawActions.clearAllClipboard}
            />
        </div>
    );
}

// Register all panel components
const components: Record<string, React.FC<IDockviewPanelProps>> = {
    timeline: TimelinePanel,
    browser: BrowserPanel,
    mixer: MixerPanel,
    pianoRoll: PianoRollPanel,
    stepSequencer: StepSequencerPanel,
    effectsRack: EffectsRackPanel,
    synthesizer: SynthesizerPanel,
    history: HistoryPanelWrapper,
    clipboard: ClipboardPanelWrapper,
};

// ═══════════════════════════════════════════════════════════════════════════
// Layout Persistence
// ═══════════════════════════════════════════════════════════════════════════

function saveLayout(api: DockviewApi) {
    try {
        const layout: SerializedDockview = api.toJSON();
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
        // Silently fail on serialization errors
    }
}

function loadSavedLayout(): SerializedDockview | null {
    try {
        const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as SerializedDockview;
    } catch {
        return null;
    }
}

function buildDefaultLayout(api: DockviewApi) {
    // Timeline - main center area (always present)
    api.addPanel({
        id: PANEL_IDS.timeline,
        component: "timeline",
        title: "Timeline",
    });

    // Mixer - bottom (shown by default)
    api.addPanel({
        id: PANEL_IDS.mixer,
        component: "mixer",
        title: "Mixer",
        position: { referencePanel: PANEL_IDS.timeline, direction: "below" },
        initialHeight: 220,
        minimumHeight: 150,
    });

    // Other panels are added dynamically via togglePanel/F-keys
}

// ═══════════════════════════════════════════════════════════════════════════
// Panel <-> DAW State Sync
// ═══════════════════════════════════════════════════════════════════════════

// Map DAW panel boolean state names to panel IDs
const STATE_TO_PANEL: Record<string, string> = {
    showBrowser: PANEL_IDS.browser,
    showMixer: PANEL_IDS.mixer,
    showPianoRoll: PANEL_IDS.pianoRoll,
    showStepSequencer: PANEL_IDS.stepSequencer,
    showEffectsRack: PANEL_IDS.effectsRack,
    showSynth: PANEL_IDS.synthesizer,
    showHistory: PANEL_IDS.history,
    showClipboard: PANEL_IDS.clipboard,
};

const PANEL_TO_STATE: Record<string, string> = {
    [PANEL_IDS.browser]: "browser",
    [PANEL_IDS.mixer]: "mixer",
    [PANEL_IDS.pianoRoll]: "pianoRoll",
    [PANEL_IDS.stepSequencer]: "stepSequencer",
    [PANEL_IDS.effectsRack]: "effectsRack",
    [PANEL_IDS.synthesizer]: "synth",
    [PANEL_IDS.history]: "history",
    [PANEL_IDS.clipboard]: "clipboard",
};

// Custom DAW theme
const dawTheme: DockviewTheme = {
    name: "daw",
    className: "dockview-theme-daw",
};

// ═══════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════

export function DAWDockview() {
    const [api, setApi] = useState<DockviewApi | null>(null);
    const apiRef = useRef<DockviewApi | null>(null);
    const dawState = useDAWState();
    const dawActions = useDAWActions();
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isSyncingRef = useRef(false);

    // ─── onReady: Initialize or restore layout ───────────────────────────
    const onReady = useCallback((event: DockviewReadyEvent) => {
        const dockApi = event.api;
        apiRef.current = dockApi;
        _dockviewApi = dockApi;
        setApi(dockApi);

        // Try to restore saved layout
        const savedLayout = loadSavedLayout();
        let restored = false;

        if (savedLayout) {
            try {
                dockApi.fromJSON(savedLayout);
                restored = true;

                // Sync restored panel visibility → DAW state
                isSyncingRef.current = true;
                for (const [panelId, panelName] of Object.entries(PANEL_TO_STATE)) {
                    const exists = !!dockApi.getPanel(panelId);
                    const stateKey = `show${panelName.charAt(0).toUpperCase() + panelName.slice(1)}` as keyof typeof dawState;
                    const currentlyShown = dawState[stateKey] as boolean;
                    if (exists !== currentlyShown) {
                        dawActions.togglePanel(panelName as "browser" | "mixer" | "pianoRoll" | "stepSequencer" | "effectsRack" | "synth" | "history" | "clipboard");
                    }
                }
                requestAnimationFrame(() => { isSyncingRef.current = false; });
            } catch {
                // Fall back to default if saved layout is invalid
            }
        }

        if (!restored) {
            buildDefaultLayout(dockApi);
        }
    }, [dawState, dawActions]);

    // ─── Persist layout on changes (debounced) ──────────────────────────
    useEffect(() => {
        if (!api) return;

        const disposable = api.onDidLayoutChange(() => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => saveLayout(api), SAVE_DEBOUNCE_MS);
        });

        return () => {
            disposable.dispose();
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, [api]);

    // ─── Sync DAW togglePanel state → dockview panels ───────────────────
    useEffect(() => {
        if (!api || isSyncingRef.current) return;

        isSyncingRef.current = true;

        // Check each panel toggle state
        const panelStates: Record<string, boolean> = {
            showBrowser: dawState.showBrowser,
            showMixer: dawState.showMixer,
            showPianoRoll: dawState.showPianoRoll,
            showStepSequencer: dawState.showStepSequencer,
            showEffectsRack: dawState.showEffectsRack,
            showSynth: dawState.showSynth,
        };

        for (const [stateKey, isVisible] of Object.entries(panelStates)) {
            const panelId = STATE_TO_PANEL[stateKey];
            if (!panelId) continue;

            const existingPanel = api.getPanel(panelId);

            if (isVisible && !existingPanel) {
                // Need to add this panel
                const meta = PANEL_META[panelId];
                if (!meta) continue;

                // Determine position based on panel type
                const hasTimeline = !!api.getPanel(PANEL_IDS.timeline);
                const hasMixer = !!api.getPanel(PANEL_IDS.mixer);

                let positionOpts: Record<string, unknown> = {};

                if (panelId === PANEL_IDS.browser) {
                    positionOpts = hasTimeline
                        ? { position: { referencePanel: PANEL_IDS.timeline, direction: "left" }, initialWidth: 260, minimumWidth: 200, maximumWidth: 400 }
                        : { position: { direction: "left" }, initialWidth: 260 };
                } else if (panelId === PANEL_IDS.mixer) {
                    positionOpts = hasTimeline
                        ? { position: { referencePanel: PANEL_IDS.timeline, direction: "below" }, initialHeight: 220, minimumHeight: 150 }
                        : { position: { direction: "below" }, initialHeight: 220 };
                } else if (panelId === PANEL_IDS.pianoRoll || panelId === PANEL_IDS.stepSequencer) {
                    // Editor panels go below timeline, or tabbed with mixer
                    positionOpts = hasMixer
                        ? { position: { referencePanel: PANEL_IDS.mixer, direction: "within" } }
                        : hasTimeline
                            ? { position: { referencePanel: PANEL_IDS.timeline, direction: "below" }, initialHeight: 300 }
                            : { position: { direction: "below" }, initialHeight: 300 };
                } else if (panelId === PANEL_IDS.effectsRack || panelId === PANEL_IDS.synthesizer) {
                    // Instrument/FX panels float by default
                    positionOpts = {
                        floating: {
                            width: 500,
                            height: 400,
                        },
                    };
                }

                api.addPanel({
                    id: panelId,
                    component: meta.component,
                    title: meta.title,
                    ...positionOpts,
                });
            } else if (!isVisible && existingPanel) {
                // Need to remove this panel
                existingPanel.api.close();
            }
        }

        isSyncingRef.current = false;
    }, [
        api,
        dawState.showBrowser,
        dawState.showMixer,
        dawState.showPianoRoll,
        dawState.showStepSequencer,
        dawState.showEffectsRack,
        dawState.showSynth,
    ]);

    // ─── Sync dockview panel close → DAW state ──────────────────────────
    useEffect(() => {
        if (!api) return;

        const disposable = api.onDidRemovePanel((event) => {
            if (isSyncingRef.current) return;

            const panelName = PANEL_TO_STATE[event.id];
            if (panelName) {
                // Check if panel is currently shown in DAW state, then toggle it off
                const stateKey = `show${panelName.charAt(0).toUpperCase() + panelName.slice(1)}` as keyof typeof dawState;
                if (dawState[stateKey]) {
                    isSyncingRef.current = true;
                    dawActions.togglePanel(panelName as "browser" | "mixer" | "pianoRoll" | "stepSequencer" | "effectsRack" | "synth" | "history" | "clipboard");
                    requestAnimationFrame(() => { isSyncingRef.current = false; });
                }
            }
        });

        return () => disposable.dispose();
    }, [api, dawState, dawActions]);

    // ─── Cleanup module-level ref on unmount ───────────────────────────
    useEffect(() => {
        return () => {
            _dockviewApi = null;
        };
    }, []);

    return (
        <div className="daw-dockview-container h-full w-full">
            <DockviewReact
                theme={dawTheme}
                onReady={onReady}
                components={components}
                defaultTabComponent={DAWTab}
                floatingGroupBounds="boundedWithinViewport"
                disableFloatingGroups={false}
            />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility: Reset layout
// ═══════════════════════════════════════════════════════════════════════════

export function resetDockviewLayout() {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    window.location.reload();
}
