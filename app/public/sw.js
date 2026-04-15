/// <reference lib="webworker" />

const CACHE_NAME = "music-org-v2";

// App shell files to precache
const PRECACHE_URLS = ["/", "/library", "/playlists", "/scanner", "/settings"];

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

    // API calls & server actions: network only
    if (url.pathname.startsWith("/api/") || request.headers.get("Next-Action")) {
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
