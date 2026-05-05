"use client";

/**
 * useRemoteEditorHost — broadcasts Sound Editor state to remote peers
 * and handles incoming commands.
 */

import { useEffect, useRef } from "react";
import { useEditor } from "@/components/editor/editor-context";
import { useRemoteOptional, type CommandHandler } from "@/components/remote/remote-context";
import type { EditorSnapshot } from "@/lib/remote-sync";

export function useRemoteEditorHost() {
    const editor = useEditor();
    const remote = useRemoteOptional();
    const rafRef = useRef(0);

    // Broadcast state at ~10fps
    useEffect(() => {
        if (!remote) return;
        let lastBroadcast = 0;

        const tick = () => {
            const now = Date.now();
            if (now - lastBroadcast >= 100) {
                lastBroadcast = now;
                const snap: EditorSnapshot = {
                    page: "editor",
                    fileName: editor.project?.name || "Untitled",
                    isPlaying: editor.isPlaying,
                    isRecording: editor.isRecording,
                    currentTime: editor.playPosition,
                    duration: editor.buffer?.duration || 0,
                    sampleRate: editor.buffer?.sampleRate || 44100,
                    channels: editor.buffer?.numberOfChannels || 2,
                    activeTool: editor.tool,
                    view: editor.view,
                    zoom: editor.zoom,
                    hasSelection: editor.selection != null && editor.selection.start !== editor.selection.end,
                    selectionStart: editor.selection?.start ?? 0,
                    selectionEnd: editor.selection?.end ?? 0,
                    isSeparatingStems: editor.isSeparatingStems,
                    stemsProgress: editor.stemsProgress,
                    stems: [],
                    peakL: editor.peakL,
                    peakR: editor.peakR,
                    canUndo: editor.canUndo,
                    canRedo: editor.canRedo,
                };
                remote.broadcastState(snap);
            }
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [remote, editor]);

    // Handle commands
    useEffect(() => {
        if (!remote) return;
        const handler: CommandHandler = (action, args, ack) => {
            try {
                const [ns, method] = action.split(".");
                if (ns !== "editor") return;

                switch (method) {
                    case "play": editor.play(); break;
                    case "pause": editor.pause(); break;
                    case "stop": editor.stop(); break;
                    case "seek": editor.seek(args[0] as number); break;
                    case "setView": editor.setView(args[0] as "waveform" | "spectrogram" | "split"); break;
                    case "setTool": editor.setTool(args[0] as Parameters<typeof editor.setTool>[0]); break;
                    case "setZoom": editor.setZoom(args[0] as number); break;
                    case "setSelection": editor.setSelection(args[0] as { start: number; end: number } | null); break;
                    case "addMarker": editor.addMarker(args[0] as number, args[1] as string | undefined); break;
                    case "removeMarker": editor.removeMarker(args[0] as string); break;
                    case "undo": editor.undo(); break;
                    case "redo": editor.redo(); break;
                    case "cut": editor.cut(); break;
                    case "copy": editor.copy(); break;
                    case "paste": editor.paste(); break;
                    case "normalize": editor.normalize(); break;
                    case "fadeIn": editor.fadeIn(args[0] as number | undefined); break;
                    case "fadeOut": editor.fadeOut(args[0] as number | undefined); break;
                    case "reverse": editor.reverse(); break;
                    case "silence": editor.silence(); break;
                    case "separateStems": editor.separateStems().then(() => ack(true)).catch(e => ack(false, String(e))); return;
                    default: ack(false, `Unknown editor command: ${method}`); return;
                }
                ack(true);
            } catch (e) {
                ack(false, String(e));
            }
        };
        return remote.onCommand(handler);
    }, [remote, editor]);
}
