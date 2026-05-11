/// <reference lib="webworker" />

const CACHE_NAME = "music-org-v5";

// Precache only TRULY public assets — the offline fallback page and the
// app manifest. Earlier versions of this SW precached `/library`,
// `/playlists`, `/settings`, … but those routes return user-specific
// HTML behind auth, so the SW would either hold the install-time user's
// content (visible to a later sign-in on the same browser → PII leak)
// or 401-redirect HTML (useless). Per-route navigation is now strictly
// network-only with no HTML caching at all (see fetch handler below).
const PRECACHE_URLS = ["/offline", "/manifest.webmanifest"];

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

// Sign-out hook from the page (`lib/auth-client.ts`). Wipe every cache so
// the next user signed in on this browser can't see the previous user's
// cached HTML or per-route assets.
self.addEventListener("message", (event) => {
    if (event.data?.type !== "purge-caches") return;
    const port = event.ports && event.ports[0];
    event.waitUntil((async () => {
        try {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        } finally {
            port?.postMessage({ ok: true });
        }
    })());
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

    // Navigation & pages: network-only. We do NOT write authenticated HTML
    // into the cache because the cache is shared across all sign-in
    // sessions on this browser — caching here is a cross-user PII leak
    // primitive. Falling back to the static `/offline` page when the
    // network is dead keeps PWA-installable behaviour.
    if (request.mode === "navigate" || request.headers.get("Accept")?.includes("text/html")) {
        event.respondWith(
            fetch(request).catch(() => caches.match("/offline") || new Response("Offline", { status: 503 })),
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

// ─── Push notifications ─────────────────────────────────────────────────────
// Server pushes a JSON payload encrypted under the user's subscription
// public key (Web Push protocol, RFC 8030). We render it as a system
// notification. Payload shape:
//   { title: string, body?: string, icon?: string, badge?: string,
//     tag?: string, url?: string, actions?: NotificationAction[] }
self.addEventListener("push", (event) => {
    let data = {};
    try {
        data = event.data?.json() ?? {};
    } catch {
        // Some senders push plain text; fall back to a generic notification.
        data = { title: "MMO", body: event.data?.text() || "" };
    }

    const title = typeof data.title === "string" && data.title.length > 0
        ? data.title.slice(0, 200)
        : "MMO";
    const body = typeof data.body === "string" ? data.body.slice(0, 500) : "";
    const tag = typeof data.tag === "string" ? data.tag : undefined;
    const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/";

    const options = {
        body,
        icon: typeof data.icon === "string" ? data.icon : "/icon-192.png",
        badge: typeof data.badge === "string" ? data.badge : "/icon-192.png",
        tag,
        renotify: !!tag,
        data: { url },
        actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined,
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = event.notification.data?.url || "/";
    event.waitUntil((async () => {
        const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        // Focus an existing same-origin window and navigate it, instead of
        // opening a duplicate tab. Falls back to openWindow on cold start.
        for (const client of allClients) {
            try {
                const clientUrl = new URL(client.url);
                if (clientUrl.origin === self.location.origin) {
                    await client.focus();
                    if (client.navigate && clientUrl.pathname + clientUrl.search !== url) {
                        await client.navigate(url);
                    }
                    return;
                }
            } catch {
                // ignore malformed client URLs
            }
        }
        await self.clients.openWindow(url);
    })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
    // The browser rotated the subscription (e.g. key expired). Re-subscribe
    // with the same applicationServerKey and POST the new subscription to
    // the server. The page picks this up via the `pushsubscriptionchange`
    // message and re-runs the subscribe flow.
    event.waitUntil((async () => {
        const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of allClients) {
            client.postMessage({ type: "pushsubscriptionchange" });
        }
    })());
});
