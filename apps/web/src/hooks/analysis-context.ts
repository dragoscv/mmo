"use client";

import { createContext, useContext } from "react";
import type { AnalysisState, AnalysisChange } from "@/hooks/use-analysis";

// ─── Context Type ────────────────────────────────────────────────────────────

export interface AnalysisContextValue extends AnalysisState {
    connected: boolean;
    modalOpen: boolean;
    openModal: () => void;
    closeModal: () => void;
    start: (
        mode: "quick" | "full",
        options: {
            metadata: boolean;
            artwork: boolean;
            lyrics: boolean;
            bpmKey: boolean;
            stems: boolean;
            skipAnalyzedDays: number | null;
            workers: number;
        }
    ) => Promise<unknown>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    stop: () => Promise<void>;
    reset: () => Promise<void>;
    fetchChanges: (jobId: number) => Promise<AnalysisChange[]>;
    applyChanges: (
        changeIds: number[]
    ) => Promise<{ applied: number; errors: number }>;
}

export const AnalysisContext = createContext<AnalysisContextValue | null>(null);

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAnalysisContext() {
    const ctx = useContext(AnalysisContext);
    if (!ctx) {
        throw new Error(
            "useAnalysisContext must be used within AnalysisProvider"
        );
    }
    return ctx;
}
