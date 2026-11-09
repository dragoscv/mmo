/**
 * Ctrl+, (Cmd+, on macOS) opens the settings modal with the search field
 * focused; when it is already open the search gets focus again.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useUiStore } from "@/state/ui-store";

interface SearchFocusRequest {
    /** True until the modal focuses its search (survives the modal's lazy first mount). */
    pending: boolean;
    request: () => void;
    consume: () => void;
}

export const useSettingsSearchFocus = create<SearchFocusRequest>((set) => ({
    pending: false,
    request: () => set({ pending: true }),
    consume: () => set({ pending: false }),
}));

/** Mount once (App). */
export function useSettingsHotkey(): void {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
            if (e.key !== "," && e.code !== "Comma") return;
            e.preventDefault();
            useSettingsSearchFocus.getState().request();
            useUiStore.getState().openSettings();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}
