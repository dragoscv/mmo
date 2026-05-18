"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";

interface FocusModeContextType {
    isFocusMode: boolean;
    toggleFocusMode: () => void;
    setFocusMode: (v: boolean) => void;
}

const FocusModeContext = createContext<FocusModeContextType | null>(null);

export function useFocusMode() {
    const ctx = useContext(FocusModeContext);
    if (!ctx) throw new Error("useFocusMode must be used within FocusModeProvider");
    return ctx;
}

/** Routes that default to focus mode (sidebar + player bar hidden). */
const FOCUS_ROUTES = ["/mixer", "/daw", "/editor", "/live", "/visualizations"];

export function FocusModeProvider({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const [isFocusMode, setIsFocusMode] = useState(false);

    // Auto-enable focus mode when navigating to a focus route,
    // and auto-disable when leaving.
    useEffect(() => {
        const shouldFocus = FOCUS_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
        // eslint-disable-next-line react-hooks/set-state-in-effect -- derived from pathname; mutable via toggle
        setIsFocusMode(shouldFocus);
    }, [pathname]);

    const toggleFocusMode = useCallback(() => {
        setIsFocusMode((v) => !v);
    }, []);

    const setFocusMode = useCallback((v: boolean) => {
        setIsFocusMode(v);
    }, []);

    return (
        <FocusModeContext.Provider value={{ isFocusMode, toggleFocusMode, setFocusMode }}>
            {children}
        </FocusModeContext.Provider>
    );
}
