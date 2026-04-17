"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const OFFLINE_DB_NAME = "mmo-offline";
const OFFLINE_STORE = "audio-files";
const OFFLINE_META_STORE = "metadata";
const OFFLINE_DB_VERSION = 1;

interface OfflineTrackMeta {
    trackId: number;
    filename: string;
    size: number;
    cachedAt: number;
    deviceId?: string;
}

interface OfflineSettings {
    enabled: boolean;
    maxStorageMB: number;
    autoDownloadCount: number; // How many recent/played tracks to auto-cache
}

const DEFAULT_SETTINGS: OfflineSettings = {
    enabled: false,
    maxStorageMB: 2048, // 2GB default
    autoDownloadCount: 50,
};

function getSettings(): OfflineSettings {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    try {
        const saved = localStorage.getItem("mmo-offline-settings");
        return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
    } catch {
        return DEFAULT_SETTINGS;
    }
}

function saveSettings(settings: OfflineSettings) {
    localStorage.setItem("mmo-offline-settings", JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent("mmo-preference-changed"));
}

// ─── IndexedDB helpers ──────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
                db.createObjectStore(OFFLINE_STORE, { keyPath: "trackId" });
            }
            if (!db.objectStoreNames.contains(OFFLINE_META_STORE)) {
                const meta = db.createObjectStore(OFFLINE_META_STORE, { keyPath: "trackId" });
                meta.createIndex("cachedAt", "cachedAt");
                meta.createIndex("size", "size");
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getOfflineMeta(db: IDBDatabase): Promise<OfflineTrackMeta[]> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_META_STORE, "readonly");
        const store = tx.objectStore(OFFLINE_META_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getOfflineBlob(db: IDBDatabase, trackId: number): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_STORE, "readonly");
        const store = tx.objectStore(OFFLINE_STORE);
        const req = store.get(trackId);
        req.onsuccess = () => resolve(req.result?.blob || null);
        req.onerror = () => reject(req.error);
    });
}

async function storeOfflineTrack(
    db: IDBDatabase,
    trackId: number,
    blob: Blob,
    meta: Omit<OfflineTrackMeta, "trackId">
) {
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction([OFFLINE_STORE, OFFLINE_META_STORE], "readwrite");
        tx.objectStore(OFFLINE_STORE).put({ trackId, blob });
        tx.objectStore(OFFLINE_META_STORE).put({ trackId, ...meta });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function removeOfflineTrack(db: IDBDatabase, trackId: number) {
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction([OFFLINE_STORE, OFFLINE_META_STORE], "readwrite");
        tx.objectStore(OFFLINE_STORE).delete(trackId);
        tx.objectStore(OFFLINE_META_STORE).delete(trackId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function clearAllOffline(db: IDBDatabase) {
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction([OFFLINE_STORE, OFFLINE_META_STORE], "readwrite");
        tx.objectStore(OFFLINE_STORE).clear();
        tx.objectStore(OFFLINE_META_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useOfflineMode() {
    const [settings, setSettings] = useState<OfflineSettings>(DEFAULT_SETTINGS);
    const [cachedTracks, setCachedTracks] = useState<OfflineTrackMeta[]>([]);
    const [totalSize, setTotalSize] = useState(0);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState<{
        current: number;
        total: number;
        trackId: number;
    } | null>(null);
    const dbRef = useRef<IDBDatabase | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Init
    useEffect(() => {
        setSettings(getSettings());
        openDB().then((db) => {
            dbRef.current = db;
            refreshMeta(db);
        });
        return () => {
            dbRef.current?.close();
        };
    }, []);

    async function refreshMeta(db?: IDBDatabase) {
        const d = db || dbRef.current;
        if (!d) return;
        const metas = await getOfflineMeta(d);
        setCachedTracks(metas);
        setTotalSize(metas.reduce((sum, m) => sum + m.size, 0));
    }

    function updateSettings(patch: Partial<OfflineSettings>) {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            saveSettings(next);
            return next;
        });
    }

    // Check if a track is available offline
    const isTrackOffline = useCallback(
        (trackId: number) => cachedTracks.some((t) => t.trackId === trackId),
        [cachedTracks]
    );

    // Get offline URL for a track (returns blob URL or null)
    const getOfflineUrl = useCallback(
        async (trackId: number): Promise<string | null> => {
            const db = dbRef.current;
            if (!db) return null;
            const blob = await getOfflineBlob(db, trackId);
            if (!blob) return null;
            return URL.createObjectURL(blob);
        },
        []
    );

    // Download a single track for offline use
    const downloadTrack = useCallback(
        async (trackId: number, filename: string, deviceId?: string) => {
            const db = dbRef.current;
            if (!db || !settings.enabled) return false;

            // Check storage limit
            const maxBytes = settings.maxStorageMB * 1024 * 1024;
            if (totalSize >= maxBytes) {
                // Evict oldest
                const sorted = [...cachedTracks].sort((a, b) => a.cachedAt - b.cachedAt);
                if (sorted.length > 0) {
                    await removeOfflineTrack(db, sorted[0].trackId);
                }
            }

            try {
                // Download via device proxy or local audio API
                const url = deviceId
                    ? `/api/audio/device/${trackId}`
                    : `/api/audio/${trackId}`;

                const resp = await fetch(url);
                if (!resp.ok) return false;

                const blob = await resp.blob();
                await storeOfflineTrack(db, trackId, blob, {
                    filename,
                    size: blob.size,
                    cachedAt: Date.now(),
                    deviceId,
                });

                await refreshMeta(db);
                return true;
            } catch {
                return false;
            }
        },
        [settings, totalSize, cachedTracks]
    );

    // Batch download multiple tracks
    const downloadBatch = useCallback(
        async (tracks: Array<{ id: number; filename: string; deviceId?: string }>) => {
            if (!settings.enabled || isDownloading) return;
            setIsDownloading(true);
            abortRef.current = new AbortController();

            let completed = 0;
            for (const track of tracks) {
                if (abortRef.current.signal.aborted) break;
                setDownloadProgress({ current: completed + 1, total: tracks.length, trackId: track.id });
                await downloadTrack(track.id, track.filename, track.deviceId);
                completed++;
            }

            setIsDownloading(false);
            setDownloadProgress(null);
            abortRef.current = null;
        },
        [settings, isDownloading, downloadTrack]
    );

    // Cancel ongoing download
    const cancelDownload = useCallback(() => {
        abortRef.current?.abort();
        setIsDownloading(false);
        setDownloadProgress(null);
    }, []);

    // Remove a track from offline cache
    const removeTrack = useCallback(
        async (trackId: number) => {
            const db = dbRef.current;
            if (!db) return;
            await removeOfflineTrack(db, trackId);
            await refreshMeta(db);
        },
        []
    );

    // Clear all offline data
    const clearAll = useCallback(async () => {
        const db = dbRef.current;
        if (!db) return;
        await clearAllOffline(db);
        await refreshMeta(db);
    }, []);

    return {
        settings,
        updateSettings,
        cachedTracks,
        totalSize,
        isTrackOffline,
        getOfflineUrl,
        downloadTrack,
        downloadBatch,
        cancelDownload,
        removeTrack,
        clearAll,
        isDownloading,
        downloadProgress,
    };
}
