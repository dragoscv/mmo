"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type JobStatus =
    | "idle"
    | "running"
    | "paused"
    | "completed"
    | "stopped";

export interface AnalysisState {
    status: JobStatus;
    jobId: number | null;
    progress: number;
    total: number;
    currentTrack: string;
    changesCount: number;
    errorsCount: number;
    errors: string[];
}

export interface AnalysisChange {
    id: number;
    jobId: number;
    trackId: number;
    trackArtist: string;
    trackTitle: string;
    field: string;
    fieldLabel: string;
    oldValue: string | null;
    newValue: string;
    newValueDisplay: string;
    source: string;
    checked: boolean;
}

const INITIAL_STATE: AnalysisState = {
    status: "idle",
    jobId: null,
    progress: 0,
    total: 0,
    currentTrack: "",
    changesCount: 0,
    errorsCount: 0,
    errors: [],
};

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAnalysis(enabled: boolean) {
    const [state, setState] = useState<AnalysisState>(INITIAL_STATE);
    const [connected, setConnected] = useState(false);
    const eventSourceRef = useRef<EventSource | null>(null);

    // Connect/disconnect SSE based on enabled flag
    useEffect(() => {
        if (!enabled) {
            eventSourceRef.current?.close();
            eventSourceRef.current = null;
            setConnected(false);
            return;
        }

        const es = new EventSource("/api/analysis/stream");
        eventSourceRef.current = es;

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setState((prev) => ({
                    ...prev,
                    status: data.status ?? prev.status,
                    jobId: data.jobId ?? prev.jobId,
                    progress: data.progress ?? prev.progress,
                    total: data.total ?? prev.total,
                    currentTrack: data.currentTrack ?? prev.currentTrack,
                    changesCount: data.changesCount ?? prev.changesCount,
                    errorsCount: data.errorsCount ?? prev.errorsCount,
                    errors: data.errors ?? prev.errors,
                }));
            } catch {
                // Ignore parse errors (heartbeats, etc.)
            }
        };

        es.onopen = () => setConnected(true);
        es.onerror = () => {
            setConnected(false);
            // EventSource auto-reconnects
        };

        return () => {
            es.close();
            eventSourceRef.current = null;
            setConnected(false);
        };
    }, [enabled]);

    // ─── Actions ─────────────────────────────────────────────────────────

    const start = useCallback(
        async (
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
        ) => {
            const res = await fetch("/api/analysis/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode, options }),
            });
            return res.json();
        },
        []
    );

    const pause = useCallback(async () => {
        await fetch("/api/analysis/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "pause" }),
        });
    }, []);

    const resume = useCallback(async () => {
        await fetch("/api/analysis/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "resume" }),
        });
    }, []);

    const stop = useCallback(async () => {
        await fetch("/api/analysis/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "stop" }),
        });
    }, []);

    const reset = useCallback(async () => {
        await fetch("/api/analysis/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reset" }),
        });
        setState(INITIAL_STATE);
    }, []);

    const fetchChanges = useCallback(
        async (jobId: number): Promise<AnalysisChange[]> => {
            const res = await fetch(`/api/analysis/changes?jobId=${jobId}`);
            const data = await res.json();
            return data.changes ?? [];
        },
        []
    );

    const applyChanges = useCallback(
        async (
            changeIds: number[]
        ): Promise<{ applied: number; errors: number }> => {
            const res = await fetch("/api/analysis/apply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ changeIds }),
            });
            return res.json();
        },
        []
    );

    return {
        ...state,
        connected,
        start,
        pause,
        resume,
        stop,
        reset,
        fetchChanges,
        applyChanges,
    };
}

// ─── Quick status check (no SSE) ────────────────────────────────────────────

export async function checkAnalysisStatus(): Promise<AnalysisState> {
    try {
        const res = await fetch("/api/analysis/status");
        return res.json();
    } catch {
        return INITIAL_STATE;
    }
}
