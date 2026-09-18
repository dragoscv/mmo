"use client";

import { Suspense } from "react";
import { AppShell } from "@mmo/ui";
import { usePlayer } from "./player-context";
import { useFocusMode } from "./focus-mode-context";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { cn } from "@/lib/utils";
import { AppSidebar } from "./app-sidebar";
import { MobileHeader } from "./mobile-header";
import { BottomNav } from "./shell/bottom-nav";
import { ScrollRestoration } from "./scroll-restoration";
import { SidebarSync, useShellSidebarProps } from "./sidebar-context";

/**
 * App frame on `@mmo/ui`'s AppShell. The player bar (AudioPlayer, 72px with a
 * track / 56px without) is `fixed` and rendered OUTSIDE this tree by
 * layout.tsx, so the shell's own `player` slot stays empty and its height is
 * exposed here as `--player-h`. `main` pads by
 * `--player-h + --shell-tabbar-height` (AppShell measures the tab bar).
 *
 * Focus mode: full-height, no sidebar / header / tab bar.
 */
export function PlayerAwareLayout({ children }: { children: React.ReactNode }) {
    const { currentTrack } = usePlayer();
    const { isFocusMode } = useFocusMode();
    const playerH = isFocusMode ? "0px" : currentTrack ? "72px" : "56px";
    const sidebarProps = useShellSidebarProps();

    useKeyboardShortcuts();

    return (
        <AppShell
            data-app-layout
            data-focus-mode={isFocusMode || undefined}
            style={{ ["--player-h" as string]: playerH }}
            className="h-dvh"
            sidebarProps={sidebarProps}
            sidebar={isFocusMode ? null : <AppSidebar />}
            header={isFocusMode ? null : <MobileHeader />}
            bottomBar={isFocusMode ? null : <BottomNav />}
            mainClassName={cn(
                "overflow-x-hidden transition-[padding] duration-(--dur-base)",
                "pb-[calc(var(--player-h)+var(--shell-tabbar-height,0px)+var(--safe-bottom,0px))]",
                "md:pb-[calc(var(--player-h)+var(--safe-bottom,0px))]"
            )}
        >
            <SidebarSync />
            {children}
            <Suspense>
                <ScrollRestoration />
            </Suspense>
        </AppShell>
    );
}
