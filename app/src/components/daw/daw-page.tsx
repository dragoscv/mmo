"use client";

import { useEffect, useCallback } from "react";
import { useDAW } from "./daw-context";
import { DAWToolbar } from "./daw-toolbar";
import { DAWTransport } from "./daw-transport";
import { DAWTimeline } from "./daw-timeline";
import { DAWMixer } from "./daw-mixer";
import { DAWPianoRoll } from "./daw-piano-roll";
import { DAWStepSequencer } from "./daw-step-sequencer";
import { DAWBrowser } from "./daw-browser";
import { DAWEffectsRack } from "./daw-effects-rack";
import { DAWSynthesizer } from "./daw-synthesizer";
import { DAWProjectModal } from "./daw-project-modal";
import { DAWSettingsModal } from "./daw-settings-modal";
import { DAWStatusBar } from "./daw-status-bar";
import { DAWExportModal } from "./daw-export-modal";
import { motion, AnimatePresence } from "framer-motion";

const panelTransition = { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const };

export function DAWPage() {
    const daw = useDAW();

    // ─── Keyboard Shortcuts ──────────────────────────────────────────────
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        const ctrl = e.ctrlKey || e.metaKey;

        switch (e.code) {
            case "Space":
                e.preventDefault();
                daw.togglePlay();
                break;
            case "Enter":
                e.preventDefault();
                daw.stop();
                break;
            case "KeyR":
                if (!ctrl) { e.preventDefault(); daw.record(); }
                break;
            case "KeyZ":
                if (ctrl && e.shiftKey) { e.preventDefault(); daw.redo(); }
                else if (ctrl) { e.preventDefault(); daw.undo(); }
                break;
            case "KeyY":
                if (ctrl) { e.preventDefault(); daw.redo(); }
                break;
            case "KeyS":
                if (ctrl) { e.preventDefault(); daw.saveCurrentProject(); }
                break;
            case "KeyE":
                if (ctrl && e.shiftKey) { e.preventDefault(); daw.setExportModal(true); }
                else if (!ctrl) daw.setTool("erase");
                break;
            case "KeyV": if (!ctrl) daw.setTool("select"); break;
            case "KeyD": if (!ctrl) daw.setTool("draw"); break;
            case "KeyC": if (!ctrl) daw.setTool("slice"); break;
            case "KeyM": if (!ctrl) daw.setTool("mute"); break;
            case "KeyA": if (!ctrl) daw.setTool("automation"); break;
            case "Digit1": if (ctrl) { e.preventDefault(); daw.setSnap("1/1"); } break;
            case "Digit2": if (ctrl) { e.preventDefault(); daw.setSnap("1/2"); } break;
            case "Digit3": if (ctrl) { e.preventDefault(); daw.setSnap("1/4"); } break;
            case "Digit4": if (ctrl) { e.preventDefault(); daw.setSnap("1/8"); } break;
            case "Digit5": if (ctrl) { e.preventDefault(); daw.setSnap("1/16"); } break;
            case "Digit0": if (ctrl) { e.preventDefault(); daw.setSnap("none"); } break;
            case "KeyK": if (!ctrl) daw.toggleMetronome(); break;
            case "KeyL": if (!ctrl) daw.toggleLoop(); break;
            case "F1": e.preventDefault(); daw.togglePanel("browser"); break;
            case "F2": e.preventDefault(); daw.togglePanel("mixer"); break;
            case "F3": e.preventDefault(); daw.togglePanel("pianoRoll"); break;
            case "F4": e.preventDefault(); daw.togglePanel("stepSequencer"); break;
            case "F5": e.preventDefault(); daw.togglePanel("effectsRack"); break;
            case "F6": e.preventDefault(); daw.togglePanel("synth"); break;
            case "F7": e.preventDefault(); daw.togglePanel("automation"); break;
            case "Delete":
            case "Backspace":
                if (daw.selectedClipId) { daw.removeClip(daw.selectedClipId); }
                break;
            case "Equal":
            case "NumpadAdd":
                if (ctrl) { e.preventDefault(); daw.setZoom(daw.zoom + 10); }
                break;
            case "Minus":
            case "NumpadSubtract":
                if (ctrl) { e.preventDefault(); daw.setZoom(daw.zoom - 10); }
                break;
            case "KeyT":
                if (ctrl && e.shiftKey) { e.preventDefault(); daw.addTrack("audio"); }
                break;
            case "KeyI":
                if (ctrl && e.shiftKey) { e.preventDefault(); daw.addTrack("midi"); }
                break;
            case "F11":
                e.preventDefault();
                daw.toggleFocusMode();
                break;
        }
    }, [daw]);

    useEffect(() => {
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handleKeyDown]);

    return (
        <div className="daw-root h-full flex flex-col bg-[var(--daw-bg)] text-[var(--daw-text)] overflow-hidden select-none">
            {/* Top controls */}
            <DAWToolbar />
            <DAWTransport />

            {/* Main content */}
            <div className="flex-1 flex min-h-0">
                {/* Left: Browser */}
                <AnimatePresence>
                    {daw.showBrowser && (
                        <motion.div
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: 260, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            transition={panelTransition}
                            className="border-r border-[var(--daw-border)] overflow-hidden flex-shrink-0"
                        >
                            <DAWBrowser />
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Center */}
                <div className="flex-1 flex flex-col min-w-0">
                    <div className="flex-1 min-h-0">
                        <DAWTimeline />
                    </div>

                    {/* Bottom editor panels */}
                    <AnimatePresence>
                        {(daw.showPianoRoll || daw.showStepSequencer || daw.showEffectsRack || daw.showSynth) && (
                            <motion.div
                                initial={{ height: 0 }}
                                animate={{ height: 300 }}
                                exit={{ height: 0 }}
                                transition={panelTransition}
                                className="border-t border-[var(--daw-border)] overflow-hidden flex-shrink-0"
                            >
                                <div className="h-full flex">
                                    {daw.showPianoRoll && <DAWPianoRoll />}
                                    {daw.showStepSequencer && !daw.showPianoRoll && <DAWStepSequencer />}
                                    {daw.showEffectsRack && <DAWEffectsRack />}
                                    {daw.showSynth && <DAWSynthesizer />}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            {/* Bottom: Mixer */}
            <AnimatePresence>
                {daw.showMixer && (
                    <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: 220 }}
                        exit={{ height: 0 }}
                        transition={panelTransition}
                        className="border-t border-[var(--daw-border)] overflow-hidden flex-shrink-0"
                    >
                        <DAWMixer />
                    </motion.div>
                )}
            </AnimatePresence>

            <DAWStatusBar />

            {/* Modals */}
            <DAWProjectModal />
            <DAWSettingsModal />
            <DAWExportModal />
        </div>
    );
}
