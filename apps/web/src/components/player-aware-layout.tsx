"use client";

import { usePlayer } from "./player-context";
import { useFocusMode } from "./focus-mode-context";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { cn } from "@/lib/utils";

export function PlayerAwareLayout({ children }: { children: React.ReactNode }) {
    const { currentTrack } = usePlayer();
    const { isFocusMode } = useFocusMode();
    const hasTrack = !!currentTrack;

    useKeyboardShortcuts();

    // Focus mode: full viewport height (no player bar offset)
    // Normal: AudioPlayer always renders: 72px with track, 56px without + safe area
    return (
        <div
            data-app-layout
            className={cn(
                "flex overflow-hidden transition-[height] duration-300",
                isFocusMode
                    ? "h-dvh"
                    : hasTrack
                        ? "h-[calc(100dvh-72px-env(safe-area-inset-bottom,0px))]"
                        : "h-[calc(100dvh-56px-env(safe-area-inset-bottom,0px))]"
            )}
        >
            {children}
        </div>
    );
}
