/// <reference lib="webworker" />

/**
 * Offline audio for the service worker (ported from the hand-rolled
 * `public/sw.js`, cache "music-org-v6").
 *
 * The page stores downloaded tracks in IndexedDB `mmo-offline`
 * (`audio-files` keyed by trackId, plus a `metadata` store — see
 * `hooks/offline-context`). When `/api/audio/:id` (or
 * `/api/audio/device/:id`) fails on the network we answer from that blob so
 * playback keeps working with no connectivity.
 */

const DB_NAME = "mmo-offline";
const DB_VERSION = 1;

export const AUDIO_ROUTE = /\/api\/audio\/(?:device\/)?(\d+)/;

export function getOfflineBlobFromIDB(trackId: number): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("audio-files")) {
                db.createObjectStore("audio-files", { keyPath: "trackId" });
            }
            if (!db.objectStoreNames.contains("metadata")) {
                const meta = db.createObjectStore("metadata", { keyPath: "trackId" });
                meta.createIndex("cachedAt", "cachedAt");
                meta.createIndex("size", "size");
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("audio-files")) {
                db.close();
                resolve(null);
                return;
            }
            const tx = db.transaction("audio-files", "readonly");
            const getReq = tx.objectStore("audio-files").get(trackId);
            getReq.onsuccess = () => {
                db.close();
                const row = getReq.result as { blob?: Blob } | undefined;
                resolve(row?.blob ?? null);
            };
            getReq.onerror = () => {
                db.close();
                reject(getReq.error);
            };
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Network first; on failure serve the IndexedDB blob, else 503.
 * Used as a serwist `RouteHandlerCallback` for `AUDIO_ROUTE`.
 */
export async function handleAudioRequest({ request, url }: { request: Request; url: URL }): Promise<Response> {
    try {
        return await fetch(request);
    } catch {
        const match = url.pathname.match(AUDIO_ROUTE);
        if (!match) return new Response("Not found", { status: 404 });
        const trackId = parseInt(match[1], 10);
        try {
            const blob = await getOfflineBlobFromIDB(trackId);
            if (blob) {
                return new Response(blob, {
                    status: 200,
                    headers: {
                        "Content-Type": blob.type || "audio/mpeg",
                        "Content-Length": String(blob.size),
                    },
                });
            }
        } catch {
            // IndexedDB error → fall through to 503
        }
        return new Response("Offline - track not cached", { status: 503 });
    }
}
