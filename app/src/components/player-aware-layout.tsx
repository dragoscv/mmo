"use client";

import { usePlayer } from "./player-context";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { cn } from "@/lib/utils";

export function PlayerAwareLayout({ children }: { children: React.ReactNode }) {
    const { currentTrack } = usePlayer();
    const hasPlayer = !!currentTrack;

    useKeyboardShortcuts();

    return (
        <div
            className={cn(
                "flex overflow-hidden transition-[height] duration-300",
                hasPlayer
                    ? "h-[calc(100dvh-72px-env(safe-area-inset-bottom,0px))]"
                    : "h-dvh"
            )}
        >
            {children}
        </div>
    );
}
