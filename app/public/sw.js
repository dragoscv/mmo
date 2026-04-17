/// <reference lib="webworker" />

const CACHE_NAME = "music-org-v2";

// App shell files to precache
const PRECACHE_URLS = ["/", "/library", "/playlists", "/scanner", "/settings", "/devices"];

// ─── IndexedDB offline audio helper ─────────────────────────────────────────

function getOfflineBlobFromIDB(trackId) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("mmo-offline", 1);
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
            const store = tx.objectStore("audio-files");
            const getReq = store.get(trackId);
            getReq.onsuccess = () => {
                db.close();
                resolve(getReq.result?.blob || null);
            };
            getReq.onerror = () => {
                db.close();
                reject(getReq.error);
            };
        };
        req.onerror = () => reject(req.error);
    });
}

// Install: precache app shell
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Fetch: network-first for navigation, cache-first for static assets
self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET and cross-origin
    if (request.method !== "GET" || url.origin !== self.location.origin) return;

    // API calls & server actions: network only (except audio which we handle below)
    if (
        (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/audio/")) ||
        request.headers.get("Next-Action")
    ) {
        return;
    }

    // Audio API: try network first, then check IndexedDB offline cache
    if (url.pathname.startsWith("/api/audio/")) {
        event.respondWith(
            fetch(request)
                .catch(async () => {
                    // Network failed - check IndexedDB offline cache
                    const trackIdMatch = url.pathname.match(/\/api\/audio\/(?:device\/)?(\d+)/);
                    if (!trackIdMatch) return new Response("Not found", { status: 404 });

                    const trackId = parseInt(trackIdMatch[1]);
                    try {
                        const blob = await getOfflineBlobFromIDB(trackId);
                        if (blob) {
                            return new Response(blob, {
                                status: 200,
                                headers: {
                                    "Content-Type": blob.type || "audio/mpeg",
                                    "Content-Length": blob.size.toString(),
                                },
                            });
                        }
                    } catch {
                        // IndexedDB error, return 503
                    }
                    return new Response("Offline - track not cached", { status: 503 });
                })
        );
        return;
    }

    // Static assets (images, fonts): cache-first
    if (url.pathname.match(/\.(png|jpg|jpeg|svg|ico|woff2?)$/)) {
        event.respondWith(
            caches.match(request).then(
                (cached) =>
                    cached ||
                    fetch(request).then((response) => {
                        if (response.ok) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                        }
                        return response;
                    })
            )
        );
        return;
    }

    // JS/CSS chunks (_next/static): network-first to avoid serving stale Turbopack chunks
    if (url.pathname.startsWith("/_next/")) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // Navigation & pages: network-first with cache fallback
    if (request.mode === "navigate" || request.headers.get("Accept")?.includes("text/html")) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
        );
        return;
    }

    // Everything else: stale-while-revalidate
    event.respondWith(
        caches.match(request).then((cached) => {
            const networkFetch = fetch(request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            });
            return cached || networkFetch;
        })
    );
});
