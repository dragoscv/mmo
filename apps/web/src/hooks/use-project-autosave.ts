"use client";

/**
 * Project autosave hook.
 *
 *  - Debounced save (default 800ms) on every `document` change.
 *  - Write-through to IndexedDB cache + queue (offline-queue.ts).
 *  - Drains the queue against the server action, with exponential backoff.
 *  - Re-drains when the browser regains connectivity (`online` event).
 *  - Periodically (every 5 min) creates an auto-snapshot.
 *
 *  Wire-up (example):
 *
 *    const { status, savedAt, queuedCount, flush } = useProjectAutosave({
 *        kind: "daw",
 *        externalId: project.id,
 *        name: project.name,
 *        document: project,         // serializable
 *    });
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    enqueueSave,
    listQueue,
    removeFromQueue,
    bumpAttempt,
    cacheProject,
    type ProjectKindKey,
} from "@/lib/offline-queue";
import { saveProject, createSnapshot } from "@/actions/projects";

export type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "queued" | "error";

interface UseProjectAutosaveOptions {
    kind: ProjectKindKey;
    externalId: string | null;
    name: string;
    document: Record<string, unknown>;
    extras?: Record<string, unknown>;
    /** Debounce window (ms). Default 800ms. */
    debounceMs?: number;
    /** Auto-snapshot interval (ms). Default 5 minutes. Pass 0 to disable. */
    snapshotIntervalMs?: number;
    /** When false, the hook is dormant (e.g. user signed out). */
    enabled?: boolean;
}

export interface AutosaveState {
    status: AutosaveStatus;
    savedAt: number | null;
    error: string | null;
    queuedCount: number;
    flush: () => Promise<void>;
}

export function useProjectAutosave(opts: UseProjectAutosaveOptions): AutosaveState {
    const {
        kind, externalId, name, document, extras,
        debounceMs = 800, snapshotIntervalMs = 5 * 60_000, enabled = true,
    } = opts;

    const [status, setStatus] = useState<AutosaveStatus>("idle");
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [queuedCount, setQueuedCount] = useState(0);

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSerializedRef = useRef<string>("");
    const isMountedRef = useRef(true);

    // Periodically refresh queue size for UI
    const refreshQueueCount = useCallback(async () => {
        try {
            const q = await listQueue();
            if (isMountedRef.current) setQueuedCount(q.length);
        } catch { /* ignore */ }
    }, []);

    const drainQueue = useCallback(async () => {
        try {
            const q = await listQueue();
            for (const entry of q) {
                try {
                    const res = await saveProject({
                        kind: entry.kind,
                        externalId: entry.externalId,
                        name: entry.name,
                        document: entry.document,
                        extras: entry.extras,
                    });
                    // Still signed out — keep the entry and stop draining; a
                    // later online/auth tick retries.
                    if (res?.deferred) break;
                    await removeFromQueue(entry.id);
                } catch {
                    await bumpAttempt(entry.id);
                    // Stop draining on first failure; rely on next online tick.
                    break;
                }
            }
        } finally {
            await refreshQueueCount();
        }
    }, [refreshQueueCount]);

    // Flush: enqueue current state and try to drain immediately.
    const flush = useCallback(async () => {
        if (!enabled || !externalId) return;
        setStatus("saving");
        setError(null);
        const serialized = JSON.stringify(document);
        if (serialized === lastSerializedRef.current) {
            setStatus("saved");
            return;
        }
        lastSerializedRef.current = serialized;
        try {
            await cacheProject(kind, externalId, name, document);
            // Try direct save first (online happy path)
            try {
                const res = await saveProject({ kind, externalId, name, document, extras });
                if (!isMountedRef.current) return;
                // No session yet (e.g. signed out / expired): keep the change
                // queued locally and retry later instead of dropping it.
                if (res?.deferred) {
                    await enqueueSave({ kind, externalId, name, document, extras });
                    setStatus("queued");
                    await refreshQueueCount();
                    return;
                }
                setStatus("saved");
                setSavedAt(Date.now());
                await drainQueue();
                return;
            } catch (directErr) {
                // Fall back to queue
                await enqueueSave({ kind, externalId, name, document, extras });
                if (!isMountedRef.current) return;
                setStatus("queued");
                setError(directErr instanceof Error ? directErr.message : String(directErr));
                await refreshQueueCount();
            }
        } catch (cacheErr) {
            setStatus("error");
            setError(cacheErr instanceof Error ? cacheErr.message : String(cacheErr));
        }
    }, [enabled, externalId, kind, name, document, extras, drainQueue, refreshQueueCount]);

    // Debounced reactive save on document changes
    useEffect(() => {
        if (!enabled || !externalId) return;
        const serialized = JSON.stringify(document);
        if (serialized === lastSerializedRef.current) return;
        setStatus("dirty");
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => { void flush(); }, debounceMs);
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [enabled, externalId, document, debounceMs, flush]);

    // Drain queue on mount + on `online`
    useEffect(() => {
        isMountedRef.current = true;
        void drainQueue();
        const onOnline = () => { void drainQueue(); };
        window.addEventListener("online", onOnline);
        return () => {
            isMountedRef.current = false;
            window.removeEventListener("online", onOnline);
        };
    }, [drainQueue]);

    // Periodic auto-snapshot
    useEffect(() => {
        if (!enabled || !externalId || snapshotIntervalMs <= 0) return;
        const t = setInterval(() => {
            (async () => {
                try {
                    await createSnapshot(kind, externalId, document);
                } catch { /* ignore */ }
            })();
        }, snapshotIntervalMs);
        return () => clearInterval(t);
    }, [enabled, externalId, kind, snapshotIntervalMs, document]);

    return useMemo(
        () => ({ status, savedAt, error, queuedCount, flush }),
        [status, savedAt, error, queuedCount, flush],
    );
}
