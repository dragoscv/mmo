"use client";

import { useEffect, useCallback } from "react";
import { useDAW } from "./daw-context";
import { DAWToolbar } from "./daw-toolbar";
import { DAWTransport } from "./daw-transport";
import { DAWProjectModal } from "./daw-project-modal";
import { DAWSettingsModal } from "./daw-settings-modal";
import { DAWStatusBar } from "./daw-status-bar";
import { DAWExportModal } from "./daw-export-modal";
import { DAWDockview } from "./daw-dockview";
import { DAWContextMenuProvider } from "./daw-context-menu";

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
            case "KeyV":
                if (ctrl) {
                    e.preventDefault();
                    // Paste clips to selected track at playhead
                    const targetTrack = daw.selectedTrackId ?? daw.project.tracks[0]?.id;
                    if (targetTrack) daw.pasteClips(targetTrack, daw.currentBeat);
                } else {
                    daw.setTool("select");
                }
                break;
            case "KeyD": if (!ctrl) daw.setTool("draw"); break;
            case "KeyC":
                if (ctrl) {
                    e.preventDefault();
                    if (daw.selectedClipId) daw.copyClips([daw.selectedClipId]);
                } else {
                    daw.setTool("slice");
                }
                break;
            case "KeyX":
                if (ctrl) {
                    e.preventDefault();
                    if (daw.selectedClipId) daw.cutClips([daw.selectedClipId]);
                }
                break;
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
            case "F8": e.preventDefault(); daw.togglePanel("history"); break;
            case "F9": e.preventDefault(); daw.togglePanel("clipboard"); break;
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
        <DAWContextMenuProvider>
            <div className="daw-root h-full flex flex-col bg-[var(--daw-bg)] text-[var(--daw-text)] overflow-hidden select-none">
                {/* Fixed top controls — always visible */}
                <DAWToolbar />
                <DAWTransport />

                {/* Dockview layout — all panels are dockable, resizable, floating */}
                <div className="flex-1 min-h-0">
                    <DAWDockview />
                </div>

                {/* Fixed bottom status bar */}
                <DAWStatusBar />

                {/* Modals (overlays, not docked) */}
                <DAWProjectModal />
                <DAWSettingsModal />
                <DAWExportModal />
            </div>
        </DAWContextMenuProvider>
    );
}
