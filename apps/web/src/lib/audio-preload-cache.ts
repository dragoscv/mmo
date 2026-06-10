/**
 * AudioPreloadCache — fetches audio files into Blob URLs so playback
 * doesn't depend on the original source after loading.
 *
 * Strategy: fetch entire file → Blob → URL.createObjectURL
 * Benefits:
 *   - Playback survives disk/network errors after load
 *   - Instant track switching for preloaded queue items
 *   - Works with HTMLAudioElement (no need for AudioBufferSourceNode)
 *
 * Memory management: LRU eviction at MAX_CACHED tracks.
 * A typical FLAC is ~30MB, MP3 ~8MB. At 20 tracks ≈ 150-600MB max.
 */

type CacheEntry = {
    blobUrl: string;
    blob: Blob;
    size: number;
    lastAccess: number;
};

type PreloadStatus = "idle" | "loading" | "cached" | "error";

type PreloadListener = (trackId: number, status: PreloadStatus, progress?: number) => void;

const MAX_CACHED = 20;
const MAX_CACHE_BYTES = 500 * 1024 * 1024; // 500MB soft limit

class AudioPreloadCache {
    private cache = new Map<number, CacheEntry>();
    private inflight = new Map<number, AbortController>();
    private totalBytes = 0;
    private listeners = new Set<PreloadListener>();

    /** Subscribe to preload status changes */
    subscribe(listener: PreloadListener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private notify(trackId: number, status: PreloadStatus, progress?: number) {
        for (const fn of this.listeners) {
            try { fn(trackId, status, progress); } catch { /* */ }
        }
    }

    /** Get a blob URL for a track if cached, otherwise the streaming URL */
    getUrl(trackId: number): string {
        const entry = this.cache.get(trackId);
        if (entry) {
            entry.lastAccess = Date.now();
            return entry.blobUrl;
        }
        return `/api/audio/${trackId}`;
    }

    /** Check if a track is already cached */
    has(trackId: number): boolean {
        return this.cache.has(trackId);
    }

    /** Get status of a track */
    getStatus(trackId: number): PreloadStatus {
        if (this.cache.has(trackId)) return "cached";
        if (this.inflight.has(trackId)) return "loading";
        return "idle";
    }

    /** Preload a track into cache. Returns the blob URL when done. */
    async preload(trackId: number): Promise<string> {
        // Already cached
        const existing = this.cache.get(trackId);
        if (existing) {
            existing.lastAccess = Date.now();
            return existing.blobUrl;
        }

        // Already in-flight — wait for it
        if (this.inflight.has(trackId)) {
            return new Promise<string>((resolve, reject) => {
                const check = () => {
                    const entry = this.cache.get(trackId);
                    if (entry) { resolve(entry.blobUrl); return; }
                    if (!this.inflight.has(trackId)) { reject(new Error("Preload cancelled")); return; }
                    setTimeout(check, 100);
                };
                check();
            });
        }

        const controller = new AbortController();
        this.inflight.set(trackId, controller);
        this.notify(trackId, "loading");

        try {
            const response = await fetch(`/api/audio/${trackId}`, {
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            // Stream with progress tracking
            const contentLength = Number(response.headers.get("content-length") || 0);
            const reader = response.body?.getReader();

            if (!reader) {
                throw new Error("No response body");
            }

            const chunks: Uint8Array[] = [];
            let received = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (contentLength > 0) {
                    this.notify(trackId, "loading", Math.round((received / contentLength) * 100));
                }
            }

            // Build blob from chunks
            const contentType = response.headers.get("content-type") || "audio/mpeg";
            const blob = new Blob(chunks as BlobPart[], { type: contentType });
            const blobUrl = URL.createObjectURL(blob);

            // Evict if needed before inserting
            this.evictIfNeeded(blob.size);

            const entry: CacheEntry = {
                blobUrl,
                blob,
                size: blob.size,
                lastAccess: Date.now(),
            };

            this.cache.set(trackId, entry);
            this.totalBytes += blob.size;
            this.inflight.delete(trackId);
            this.notify(trackId, "cached");

            return blobUrl;
        } catch (err) {
            this.inflight.delete(trackId);
            if ((err as Error).name !== "AbortError") {
                this.notify(trackId, "error");
            }
            // Return streaming URL as fallback
            return `/api/audio/${trackId}`;
        }
    }

    /** Preload multiple tracks (e.g., next N in queue). Non-blocking. */
    preloadMany(trackIds: number[]): void {
        for (const id of trackIds) {
            if (!this.cache.has(id) && !this.inflight.has(id)) {
                this.preload(id).catch(() => { /* non-fatal */ });
            }
        }
    }

    /** Cancel an in-progress preload */
    cancel(trackId: number): void {
        const controller = this.inflight.get(trackId);
        if (controller) {
            controller.abort();
            this.inflight.delete(trackId);
        }
    }

    /** Evict a specific track from cache */
    evict(trackId: number): void {
        const entry = this.cache.get(trackId);
        if (entry) {
            URL.revokeObjectURL(entry.blobUrl);
            this.totalBytes -= entry.size;
            this.cache.delete(trackId);
        }
    }

    /** LRU eviction to make room for new data */
    private evictIfNeeded(incomingBytes: number): void {
        // Evict by count
        while (this.cache.size >= MAX_CACHED) {
            this.evictLRU();
        }
        // Evict by total size
        while (this.totalBytes + incomingBytes > MAX_CACHE_BYTES && this.cache.size > 0) {
            this.evictLRU();
        }
    }

    private evictLRU(): void {
        let oldest: { id: number; access: number } | null = null;
        for (const [id, entry] of this.cache) {
            if (!oldest || entry.lastAccess < oldest.access) {
                oldest = { id, access: entry.lastAccess };
            }
        }
        if (oldest) {
            this.evict(oldest.id);
        }
    }

    /** Get cache stats (for debug UI) */
    getStats() {
        return {
            count: this.cache.size,
            totalBytes: this.totalBytes,
            inflight: this.inflight.size,
            maxCount: MAX_CACHED,
            maxBytes: MAX_CACHE_BYTES,
            entries: Array.from(this.cache.entries()).map(([id, e]) => ({
                trackId: id,
                sizeMB: Math.round(e.size / 1024 / 1024 * 10) / 10,
                lastAccess: e.lastAccess,
            })),
        };
    }

    /** Clear entire cache */
    clear(): void {
        for (const [, entry] of this.cache) {
            URL.revokeObjectURL(entry.blobUrl);
        }
        this.cache.clear();
        this.totalBytes = 0;
        // Cancel all in-flight
        for (const [, controller] of this.inflight) {
            controller.abort();
        }
        this.inflight.clear();
    }
}

// Singleton
export const audioPreloadCache = new AudioPreloadCache();
