"use client";

import {
    useState,
    useEffect,
    useCallback,
    type ReactNode,
} from "react";
import {
    useAnalysis,
    checkAnalysisStatus,
} from "@/hooks/use-analysis";
import {
    AnalysisContext,
    type AnalysisContextValue,
} from "@/hooks/analysis-context";
import { AnalyzeModal } from "@/components/analyze-modal-v2";
import { AnalysisFloatingStatus } from "@/components/analysis-floating-status";
import { useRenderCount } from "@/lib/dev-debugger";

export { useAnalysisContext } from "@/hooks/analysis-context";

// ─── Provider ────────────────────────────────────────────────────────────────

const ANALYSIS_MODAL_KEY = "analysis-modal-open";

function loadModalOpen(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return localStorage.getItem(ANALYSIS_MODAL_KEY) === "true";
    } catch {
        return false;
    }
}

function saveModalOpen(open: boolean) {
    try {
        if (open) {
            localStorage.setItem(ANALYSIS_MODAL_KEY, "true");
        } else {
            localStorage.removeItem(ANALYSIS_MODAL_KEY);
        }
    } catch { }
}

export function AnalysisProvider({ children }: { children: ReactNode }) {
    useRenderCount("AnalysisProvider");
    const [modalOpen, setModalOpen] = useState(false);

    // SSE should be connected when analysis is active OR modal is open
    const [sseEnabled, setSseEnabled] = useState(false);
    const analysis = useAnalysis(sseEnabled);

    // Determine if SSE should be on
    const isActive =
        analysis.status === "running" || analysis.status === "paused";
    const needsReview =
        analysis.status === "completed" || analysis.status === "stopped";

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- derived sync; legacy state machine, refactor tracked separately
        setSseEnabled(modalOpen || isActive);
    }, [modalOpen, isActive]);

    // Persist modal open state
    const handleModalChange = useCallback((open: boolean) => {
        setModalOpen(open);
        saveModalOpen(open);
    }, []);

    // On mount: only re-open modal if it was open before AND analysis is active
    useEffect(() => {
        const wasOpen = loadModalOpen();
        checkAnalysisStatus().then((status) => {
            const active = status.status === "running" || status.status === "paused";
            const hasResults = status.status === "completed" || status.status === "stopped";
            if (wasOpen && (active || hasResults)) {
                setModalOpen(true);
                setSseEnabled(true);
            } else if (!active && !hasResults) {
                // Analysis is idle — clear the persisted flag
                saveModalOpen(false);
            }
            // If analysis is active but modal wasn't open, just enable SSE for floating widget
            if (!wasOpen && (active || hasResults)) {
                setSseEnabled(true);
            }
        });
    }, []);

    const openModal = useCallback(() => handleModalChange(true), [handleModalChange]);
    const closeModal = useCallback(() => handleModalChange(false), [handleModalChange]);

    const value: AnalysisContextValue = {
        ...analysis,
        modalOpen,
        openModal,
        closeModal,
        start: analysis.start,
        pause: analysis.pause,
        resume: analysis.resume,
        stop: analysis.stop,
        reset: analysis.reset,
        fetchChanges: analysis.fetchChanges,
        applyChanges: analysis.applyChanges,
    };

    // Show floating status when analysis is active but modal is closed
    const showFloating = !modalOpen && (isActive || needsReview);

    return (
        <AnalysisContext.Provider value={value}>
            {children}
            <AnalyzeModal open={modalOpen} onOpenChange={handleModalChange} />
            {showFloating && (
                <AnalysisFloatingStatus
                    status={analysis.status}
                    progress={analysis.progress}
                    total={analysis.total}
                    changesCount={analysis.changesCount}
                    currentTrack={analysis.currentTrack}
                    onOpen={openModal}
                    onPause={analysis.pause}
                    onResume={analysis.resume}
                />
            )}
        </AnalysisContext.Provider>
    );
}
