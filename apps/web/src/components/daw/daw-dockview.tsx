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
// Touch → HTML5 Drag-and-Drop polyfill. Dockview's tab/group dragging uses
// the native HTML5 DnD API (draggable=true + dragstart/dragend), which does
// not fire on touch devices. This polyfill translates touchstart/touchmove/
// touchend into synthetic drag events so tabs (and floating windows) can be
// repositioned with a finger.
import { polyfill as enableTouchDnD } from "mobile-drag-drop";
import "mobile-drag-drop/default.css";
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
import { VoiceProcessor } from "./daw-voice-processor";
import { useDAWActions, useDAWState } from "./daw-context";
import { useContextMenu, useLongPress, type MenuEntry } from "./daw-context-menu";
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
let touchDnDApplied = false;

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
    voiceProcessor: "panel_voice_processor",
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
    [PANEL_IDS.voiceProcessor]: { title: "Voice Processor", component: "voiceProcessor", shortcut: "F10" },
};

// ═══════════════════════════════════════════════════════════════════════════
// Custom Tab with Context Menu
// ═══════════════════════════════════════════════════════════════════════════

function DAWTab({ api, containerApi }: IDockviewPanelHeaderProps) {
    const [title, setTitle] = useState(api.title ?? "");
    const ctxMenu = useContextMenu();

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- external subscription (dockview title change event)
        const d = api.onDidTitleChange(e => setTitle(e.title));
        // eslint-disable-next-line react-hooks/set-state-in-effect -- prop sync from dockview api on mount
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

    // Touch long-press → same context menu (right-click equivalent on mobile)
    const longPress = useLongPress((x, y) => {
        handleContextMenu({ clientX: x, clientY: y, preventDefault: () => { /* noop */ } } as React.MouseEvent);
    });

    return (
        <div
            className="dv-default-tab"
            onContextMenu={handleContextMenu}
            {...longPress}
        >
            <span className="dv-default-tab-content">{title}</span>
            {api.id !== PANEL_IDS.timeline && (
                <div
                    className="dv-default-tab-action"
                    // Stop the event from reaching dockview's tab-drag handler,
                    // so tapping the close X never starts a drag. Don't call
                    // preventDefault (that suppresses the synthesised click on
                    // touch devices, breaking the close button on mobile).
                    onPointerDown={e => e.stopPropagation()}
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

function VoiceProcessorPanel() {
    return (
        <div className="h-full w-full overflow-hidden">
            <VoiceProcessor />
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
    voiceProcessor: VoiceProcessorPanel,
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
    showVoiceProcessor: PANEL_IDS.voiceProcessor,
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
    [PANEL_IDS.voiceProcessor]: "voiceProcessor",
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

    // ─── Touch DnD polyfill (one-shot, idempotent) ───────────────────────
    // Dockview uses TWO separate drag systems:
    //   1. HTML5 DnD (draggable + dragstart) for moving tabs between groups
    //   2. Pointer events (pointerdown/pointermove on window) for moving
    //      the entire floating window by its title bar
    //
    // On touch, system #1 is broken because HTML5 DnD doesn't fire — hence
    // the polyfill. But the polyfill calls preventDefault() on touchstart,
    // which suppresses pointer events too — breaking system #2.
    //
    // Solution: skip the polyfill entirely when the touch target is inside
    // a floating window's title bar (let the native pointer-event drag
    // handle window repositioning), but enable it for docked tab strips
    // (where HTML5 DnD is the only available mechanism).
    useEffect(() => {
        if (touchDnDApplied) return;
        touchDnDApplied = true;
        enableTouchDnD({
            holdToDrag: 200,
            dragImageCenterOnTouch: false,
            tryFindDraggableTarget: (event: TouchEvent) => {
                const touch = event.touches[0];
                if (!touch) return undefined;
                const target = touch.target as Element | null;
                if (!target || !(target instanceof Element)) return undefined;

                // Skip the polyfill entirely when the touch is on a
                // floating-window drag/resize handle — pointer events
                // (with our setPointerCapture injection below) drive
                // those drags natively, and the polyfill's preventDefault
                // on touchstart would otherwise suppress them.
                if (
                    target.closest(
                        ".dv-floating-group, .dv-resize-container, .dv-void-container, .dv-resize-handle, [class^='dv-resize-handle-']"
                    )
                ) {
                    return undefined;
                }

                // Otherwise walk up looking for a draggable element (the
                // polyfill's default behaviour for docked tabs).
                let el: Element | null = target;
                while (el && el !== document.body) {
                    if (el instanceof HTMLElement && el.draggable) return el;
                    el = el.parentElement;
                }
                return undefined;
            },
        });
    }, []);

    // ─── Touch drag fix: inject setPointerCapture into dockview drags ────
    // Root cause of broken touch drag (verified by reading dockview source):
    // dockview never calls setPointerCapture anywhere. On touch, the OS
    // fires `pointercancel` after a few pixels of motion (because no one
    // claimed the gesture), and dockview's `window.pointermove` listener
    // simply stops receiving events → drag freezes after a few pixels.
    //
    // Fix: in the CAPTURE phase (before dockview's bubble-phase listener),
    // call setPointerCapture on the actual drag-handle element. This tells
    // the OS to deliver every pointermove/pointerup for this pointer to
    // that element until release — pointercancel never fires.
    //
    // Drag handles per dockview source:
    //   • `.dv-void-container`            — moves a floating window
    //   • `.dv-resize-handle*`            — resizes a floating window
    //   • `.dv-tab` (with draggable=true) — for tab rearrange (HTML5 DnD,
    //                                       handled by polyfill instead)
    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
            const target = e.target as Element | null;
            if (!target || !(target instanceof Element)) return;
            const handle = target.closest(
                ".dv-void-container, .dv-resize-handle, [class^='dv-resize-handle-']"
            ) as HTMLElement | null;
            if (!handle) return;
            try {
                handle.setPointerCapture(e.pointerId);
                document.documentElement.classList.add("daw-dockview-dragging");
            } catch {
                /* element gone or pointer not active — ignore */
            }
        };
        const cleanup = () => {
            document.documentElement.classList.remove("daw-dockview-dragging");
            // Defer dockview-class strip so its own pointerup handler runs
            // first; we only clean up if it left something stuck.
            setTimeout(() => {
                document
                    .querySelectorAll(
                        ".dv-resize-container-dragging, .dv-tab-dragging, .dv-tab--dragging, .dv-dragged"
                    )
                    .forEach(el => {
                        el.classList.remove(
                            "dv-resize-container-dragging",
                            "dv-tab-dragging",
                            "dv-tab--dragging",
                            "dv-dragged",
                        );
                    });
            }, 0);
        };
        // Capture phase so we run BEFORE dockview's bubble-phase listener.
        window.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("pointerup", cleanup);
        window.addEventListener("pointercancel", cleanup);
        window.addEventListener("touchend", cleanup);
        window.addEventListener("touchcancel", cleanup);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("pointerup", cleanup);
            window.removeEventListener("pointercancel", cleanup);
            window.removeEventListener("touchend", cleanup);
            window.removeEventListener("touchcancel", cleanup);
        };
    }, []);

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
                        dawActions.togglePanel(panelName as "browser" | "mixer" | "pianoRoll" | "stepSequencer" | "effectsRack" | "synth" | "history" | "clipboard" | "voiceProcessor");
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
            showVoiceProcessor: dawState.showVoiceProcessor,
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
                } else if (panelId === PANEL_IDS.voiceProcessor) {
                    // Voice processor floats as a wide panel
                    positionOpts = {
                        floating: {
                            width: 380,
                            height: 600,
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
        dawState.showVoiceProcessor,
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
                    dawActions.togglePanel(panelName as "browser" | "mixer" | "pianoRoll" | "stepSequencer" | "effectsRack" | "synth" | "history" | "clipboard" | "voiceProcessor");
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
