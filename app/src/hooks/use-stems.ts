"use client";

import { useState, useCallback, useRef } from "react";
import {
    type StemType,
    type StemConfig,
    type StemSeparationResult,
    type StemProgressCallback,
    type StemProgress,
    STEM_TYPES,
    createDefaultStemConfigs,
    separateStems,
} from "@/lib/stems-engine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseStemsReturn {
    // State
    configs: StemConfig[];
    isProcessing: boolean;
    progress: StemProgress | null;
    result: StemSeparationResult | null;
    error: string | null;

    // Actions
    separate: (buffer: AudioBuffer) => Promise<StemSeparationResult | null>;
    cancel: () => void;
    reset: () => void;

    // Config actions
    setStemVolume: (stem: StemType, volume: number) => void;
    toggleStemMute: (stem: StemType) => void;
    toggleStemSolo: (stem: StemType) => void;
    setStemEnabled: (stem: StemType, enabled: boolean) => void;
    resetConfigs: () => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useStems(): UseStemsReturn {
    const [configs, setConfigs] = useState<StemConfig[]>(createDefaultStemConfigs);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState<StemProgress | null>(null);
    const [result, setResult] = useState<StemSeparationResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const cancelRef = useRef(false);

    const separate = useCallback(async (buffer: AudioBuffer): Promise<StemSeparationResult | null> => {
        setIsProcessing(true);
        setError(null);
        setResult(null);
        cancelRef.current = false;

        const onProgress: StemProgressCallback = (p) => {
            if (cancelRef.current) return;
            setProgress(p);
        };

        try {
            onProgress({ stage: "loading", progress: 0, message: "Preparing audio..." });
            const stemResult = await separateStems(buffer, onProgress);

            if (cancelRef.current) {
                return null;
            }

            setResult(stemResult);
            setIsProcessing(false);
            return stemResult;
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Stem separation failed";
            setError(msg);
            setIsProcessing(false);
            setProgress({ stage: "error", progress: 0, message: msg });
            return null;
        }
    }, []);

    const cancel = useCallback(() => {
        cancelRef.current = true;
        setIsProcessing(false);
        setProgress(null);
    }, []);

    const reset = useCallback(() => {
        cancelRef.current = true;
        setIsProcessing(false);
        setProgress(null);
        setResult(null);
        setError(null);
    }, []);

    const setStemVolume = useCallback((stem: StemType, volume: number) => {
        setConfigs(prev => prev.map(c =>
            c.type === stem ? { ...c, volume: Math.max(0, Math.min(1, volume)) } : c
        ));
    }, []);

    const toggleStemMute = useCallback((stem: StemType) => {
        setConfigs(prev => prev.map(c =>
            c.type === stem ? { ...c, muted: !c.muted } : c
        ));
    }, []);

    const toggleStemSolo = useCallback((stem: StemType) => {
        setConfigs(prev => {
            const current = prev.find(c => c.type === stem);
            if (!current) return prev;
            const newSolo = !current.solo;
            return prev.map(c => ({ ...c, solo: c.type === stem ? newSolo : false }));
        });
    }, []);

    const setStemEnabled = useCallback((stem: StemType, enabled: boolean) => {
        setConfigs(prev => prev.map(c =>
            c.type === stem ? { ...c, enabled } : c
        ));
    }, []);

    const resetConfigs = useCallback(() => {
        setConfigs(createDefaultStemConfigs());
    }, []);

    return {
        configs,
        isProcessing,
        progress,
        result,
        error,
        separate,
        cancel,
        reset,
        setStemVolume,
        toggleStemMute,
        toggleStemSolo,
        setStemEnabled,
        resetConfigs,
    };
}
