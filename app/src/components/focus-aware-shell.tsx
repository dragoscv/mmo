"use client";

import { useFocusMode } from "./focus-mode-context";
import { cn } from "@/lib/utils";

/** Hides the sidebar when focus mode is active. */
export function FocusAwareSidebar({ children }: { children: React.ReactNode }) {
    const { isFocusMode } = useFocusMode();

    return (
        <div
            data-app-sidebar=""
            className={cn(
                "self-stretch transition-all duration-300",
                isFocusMode && "hidden"
            )}
        >
            {children}
        </div>
    );
}

/** Hides the mobile header when focus mode is active. */
export function FocusAwareMobileHeader({ children }: { children: React.ReactNode }) {
    const { isFocusMode } = useFocusMode();
    if (isFocusMode) return null;
    return <>{children}</>;
}

/** Hides the now playing bar when focus mode is active. */
export function FocusAwareNowPlayingBar({ children }: { children: React.ReactNode }) {
    const { isFocusMode } = useFocusMode();

    return (
        <div
            data-app-nowplaying=""
            className={cn(
                "transition-all duration-300",
                isFocusMode && "hidden"
            )}
        >
            {children}
        </div>
    );
}
