"use client";

import { useEffect, useCallback } from "react";
import { usePlayer } from "@/components/player-context";

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return false;
}

export function useKeyboardShortcuts() {
    const player = usePlayer();

    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            // Don't intercept when typing in inputs
            if (isInputFocused()) return;

            // Don't intercept when modifiers are held (except Shift for some combos)
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            switch (e.key) {
                // ─── Playback ─────────────────────────────────────────
                case " ": // Space — Play/Pause
                    e.preventDefault();
                    player.togglePlay();
                    break;

                case "ArrowRight": // → — Next track (or seek forward +5s with Shift)
                    e.preventDefault();
                    if (e.shiftKey) {
                        player.seek(Math.min(player.duration, player.currentTime + 5));
                    } else {
                        player.next();
                    }
                    break;

                case "ArrowLeft": // ← — Previous track (or seek back -5s with Shift)
                    e.preventDefault();
                    if (e.shiftKey) {
                        player.seek(Math.max(0, player.currentTime - 5));
                    } else {
                        player.prev();
                    }
                    break;

                // ─── Volume ───────────────────────────────────────────
                case "ArrowUp": // ↑ — Volume up
                    e.preventDefault();
                    player.setVolume(Math.min(1, player.volume + 0.05));
                    break;

                case "ArrowDown": // ↓ — Volume down
                    e.preventDefault();
                    player.setVolume(Math.max(0, player.volume - 0.05));
                    break;

                case "m": // M — Mute/unmute
                case "M":
                    e.preventDefault();
                    if (e.shiftKey) {
                        // Shift+M — Open mixer view
                        player.openNowPlayingView("mixer");
                    } else {
                        player.setVolume(player.volume > 0 ? 0 : 0.8);
                    }
                    break;

                // ─── Modes ────────────────────────────────────────────
                case "s": // S — Toggle shuffle
                case "S":
                    e.preventDefault();
                    player.toggleShuffle();
                    break;

                case "r": // R — Toggle repeat
                case "R":
                    e.preventDefault();
                    player.toggleRepeat();
                    break;

                // ─── Now Playing ──────────────────────────────────────
                case "n": // N — Toggle now playing
                case "N":
                    e.preventDefault();
                    player.toggleNowPlaying();
                    break;

                case "Escape": // Esc — Close now playing
                    if (player.isNowPlayingOpen) {
                        e.preventDefault();
                        player.closeNowPlaying();
                    }
                    break;
            }
        },
        [player]
    );

    useEffect(() => {
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [handleKeyDown]);
}
