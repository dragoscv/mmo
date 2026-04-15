"use client";

import {
    createContext,
    useContext,
    useState,
    useCallback,
    useEffect,
    useRef,
    type ReactNode,
} from "react";

interface SidebarContextType {
    collapsed: boolean;
    mobileOpen: boolean;
    toggle: () => void;
    setCollapsed: (v: boolean) => void;
    openMobile: () => void;
    closeMobile: () => void;
}

const SidebarContext = createContext<SidebarContextType | null>(null);

export function useSidebar() {
    const ctx = useContext(SidebarContext);
    if (!ctx) throw new Error("useSidebar must be used within SidebarProvider");
    return ctx;
}

const STORAGE_KEY = "sidebar-collapsed";

export function SidebarProvider({ children }: { children: ReactNode }) {
    const [collapsed, setCollapsedState] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);

    // Restore from localStorage
    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === "true") setCollapsedState(true);
    }, []);

    const setCollapsed = useCallback((v: boolean) => {
        setCollapsedState(v);
        localStorage.setItem(STORAGE_KEY, String(v));
    }, []);

    const toggle = useCallback(() => {
        setCollapsed(!collapsed);
    }, [collapsed, setCollapsed]);

    const openMobile = useCallback(() => setMobileOpen(true), []);
    const closeMobile = useCallback(() => setMobileOpen(false), []);

    // Close mobile on escape key
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMobileOpen(false);
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, []);

    // Swipe gestures for mobile sidebar: right to open, left to close
    const touchRef = useRef<{ x: number; y: number; time: number } | null>(null);

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

            // Don't interfere with Now Playing
            const target = e.target as HTMLElement;
            if (target.closest("[data-nowplaying]")) return;

            // Don't interfere with scrollable containers (tables, overflow areas)
            if (target.closest("table, [data-radix-scroll-area-viewport], .overflow-x-auto, .overflow-auto")) return;

            if (dx > 60) {
                // Only open sidebar if swipe started from the left 15% of screen
                if (startX <= window.innerWidth * 0.15) setMobileOpen(true);
            }
            if (dx < -60) setMobileOpen(false);
        };

        document.addEventListener("touchstart", onTouchStart, { passive: true });
        document.addEventListener("touchend", onTouchEnd, { passive: true });
        return () => {
            document.removeEventListener("touchstart", onTouchStart);
            document.removeEventListener("touchend", onTouchEnd);
        };
    }, []);

    return (
        <SidebarContext.Provider
            value={{ collapsed, mobileOpen, toggle, setCollapsed, openMobile, closeMobile }}
        >
            {children}
        </SidebarContext.Provider>
    );
}
