"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { SidebarProvider as UiSidebarProvider, useSidebar as useUiSidebar, type SidebarContextValue } from "@mmo/ui";

/**
 * Thin adapter over `@mmo/ui`'s SidebarProvider/useSidebar that preserves the
 * app's historical API (`collapsed`, `mobileOpen`, `toggle`, `setCollapsed`,
 * `openMobile`, `closeMobile`).
 *
 * Persistence lives in @mmo/ui (`mixai:sidebar`, migrated from the legacy
 * `sidebar-collapsed` key — both prefixes are syncable, see lib/syncable-keys).
 *
 * `AppShell` mounts a second (inner) `SidebarProvider` for its own primitives.
 * This module keeps ONE source of truth — the outer store from layout.tsx — and
 * bridges the inner one via `useShellSidebarProps()` + `<SidebarSync/>`, so
 * `openMobile()` from anywhere (e.g. AudioPlayer, outside the shell) works.
 */
export interface SidebarContextType {
    collapsed: boolean;
    mobileOpen: boolean;
    /** Collapses/expands on desktop, opens/closes the drawer on mobile. */
    toggle: () => void;
    setCollapsed: (v: boolean) => void;
    openMobile: () => void;
    closeMobile: () => void;
    isMobile: boolean;
}

const OuterSidebarContext = createContext<SidebarContextValue | null>(null);

function useOuterSidebar(): SidebarContextValue {
    const ctx = useContext(OuterSidebarContext);
    if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
    return ctx;
}

export function useSidebar(): SidebarContextType {
    const ui = useOuterSidebar();
    const { setMobileOpen } = ui;
    const openMobile = useCallback(() => setMobileOpen(true), [setMobileOpen]);
    const closeMobile = useCallback(() => setMobileOpen(false), [setMobileOpen]);
    return useMemo(
        () => ({
            collapsed: ui.collapsed,
            mobileOpen: ui.mobileOpen,
            toggle: ui.toggle,
            setCollapsed: ui.setCollapsed,
            openMobile,
            closeMobile,
            isMobile: ui.isMobile,
        }),
        [ui.collapsed, ui.mobileOpen, ui.toggle, ui.setCollapsed, ui.isMobile, openMobile, closeMobile]
    );
}

/** Props for `AppShell.sidebarProps` so the inner provider mirrors the outer collapsed state. */
export function useShellSidebarProps() {
    const { collapsed, setCollapsed } = useOuterSidebar();
    return useMemo(() => ({ collapsed, onCollapsedChange: setCollapsed }), [collapsed, setCollapsed]);
}

/** Mount INSIDE AppShell: two-way sync of `mobileOpen` between inner and outer providers. */
export function SidebarSync() {
    const inner = useUiSidebar();
    const outer = useOuterSidebar();
    const lastOuter = useRef(outer.mobileOpen);
    const lastInner = useRef(inner.mobileOpen);

    useEffect(() => {
        if (outer.mobileOpen !== lastOuter.current) {
            lastOuter.current = outer.mobileOpen;
            lastInner.current = outer.mobileOpen;
            inner.setMobileOpen(outer.mobileOpen);
        }
    }, [outer.mobileOpen, inner]);

    useEffect(() => {
        if (inner.mobileOpen !== lastInner.current) {
            lastInner.current = inner.mobileOpen;
            lastOuter.current = inner.mobileOpen;
            outer.setMobileOpen(inner.mobileOpen);
        }
    }, [inner.mobileOpen, outer]);

    return null;
}

/** Edge-swipe to open + swipe-left to close + Esc to close (mobile only). */
function SidebarGestures() {
    const { setMobileOpen } = useUiSidebar();
    const touchRef = useRef<{ x: number; y: number; time: number } | null>(null);

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMobileOpen(false);
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [setMobileOpen]);

    useEffect(() => {
        const isMobile = () => window.innerWidth < 768;

        const onTouchStart = (e: TouchEvent) => {
            if (!isMobile()) return;
            const touch = e.touches[0];
            touchRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (!isMobile() || !touchRef.current) return;
            const touch = e.changedTouches[0];
            const dx = touch.clientX - touchRef.current.x;
            const dy = touch.clientY - touchRef.current.y;
            const startX = touchRef.current.x;
            const dt = Date.now() - touchRef.current.time;
            touchRef.current = null;

            // Must be a quick, primarily horizontal swipe
            if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) || dt > 400) return;

            const target = e.target as HTMLElement;
            // Don't interfere with Now Playing or the drawer's own swipe-to-close
            if (target.closest("[data-nowplaying], [data-slot='sidebar-mobile']")) return;
            // Don't interfere with scrollable containers (tables, overflow areas)
            if (target.closest("table, [data-radix-scroll-area-viewport], .overflow-x-auto, .overflow-auto")) return;

            // Only open when the swipe started from the left 15% of the screen
            if (dx > 60 && startX <= window.innerWidth * 0.15) setMobileOpen(true);
            if (dx < -60) setMobileOpen(false);
        };

        document.addEventListener("touchstart", onTouchStart, { passive: true });
        document.addEventListener("touchend", onTouchEnd, { passive: true });
        return () => {
            document.removeEventListener("touchstart", onTouchStart);
            document.removeEventListener("touchend", onTouchEnd);
        };
    }, [setMobileOpen]);

    return null;
}

function OuterCapture({ children }: { children: ReactNode }) {
    const ui = useUiSidebar();
    return <OuterSidebarContext.Provider value={ui}>{children}</OuterSidebarContext.Provider>;
}

export function SidebarProvider({ children }: { children: ReactNode }) {
    return (
        <UiSidebarProvider>
            <OuterCapture>
                <SidebarGestures />
                {children}
            </OuterCapture>
        </UiSidebarProvider>
    );
}
