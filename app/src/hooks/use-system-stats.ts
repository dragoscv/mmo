"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

export interface GpuInfo {
    index: number;
    model: string;
    vramTotal: number;
}

export interface SystemStats {
    cpuUsage: number;
    cpuTemp: number;
    cpuModel: string;
    cpuCores: number;
    ramUsed: number;
    ramTotal: number;
    ramUsage: number;
    gpuUsage: number;
    gpuTemp: number;
    gpuModel: string;
    gpuVram: number;
    gpuVramTotal: number;
    gpuIndex: number;
    availableGpus: GpuInfo[];
    connected: boolean;
}

// ─── External Store ──────────────────────────────────────────────────────

let current: SystemStats = {
    cpuUsage: 0,
    cpuTemp: 0,
    cpuModel: "",
    cpuCores: 0,
    ramUsed: 0,
    ramTotal: 0,
    ramUsage: 0,
    gpuUsage: 0,
    gpuTemp: 0,
    gpuModel: "",
    gpuVram: 0,
    gpuVramTotal: 0,
    gpuIndex: 0,
    availableGpus: [],
    connected: false,
};

const listeners = new Set<() => void>();
let eventSource: EventSource | null = null;
let currentUrl = "";

function notify() {
    listeners.forEach((fn) => fn());
}

function connect(gpuIndex: number, pollInterval: number) {
    const url = `/api/system-stats?gpu=${gpuIndex}&interval=${pollInterval * 1000}`;

    // Reconnect if params changed
    if (eventSource && currentUrl !== url) {
        eventSource.close();
        eventSource = null;
    }
    if (eventSource) return;
    currentUrl = url;

    eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            current = { ...data, connected: true };
            notify();
        } catch {
            // Ignore parse errors
        }
    };

    eventSource.onerror = () => {
        if (current.connected) {
            current = { ...current, connected: false };
            notify();
        }
    };

    eventSource.onopen = () => {
        if (!current.connected) {
            current = { ...current, connected: true };
            notify();
        }
    };
}

function disconnect() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
        currentUrl = "";
        current = { ...current, connected: false };
        notify();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): SystemStats {
    return current;
}

// ─── Hook ────────────────────────────────────────────────────────────────

let refCount = 0;

export function useSystemStats(gpuIndex = 0, pollInterval = 2): SystemStats {
    const prevRef = useRef({ gpuIndex, pollInterval });

    useEffect(() => {
        refCount++;
        connect(gpuIndex, pollInterval);

        return () => {
            refCount--;
            if (refCount <= 0) {
                refCount = 0;
                disconnect();
            }
        };
    }, []);

    // Reconnect if params change
    useEffect(() => {
        if (prevRef.current.gpuIndex !== gpuIndex || prevRef.current.pollInterval !== pollInterval) {
            prevRef.current = { gpuIndex, pollInterval };
            if (eventSource) {
                eventSource.close();
                eventSource = null;
                connect(gpuIndex, pollInterval);
            }
        }
    }, [gpuIndex, pollInterval]);

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
