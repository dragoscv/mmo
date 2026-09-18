/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * MixAI service worker (WP9-05) — built by `serwist build` (configurator
 * mode, `serwist.config.mjs`) into `public/sw.js` after `next build`.
 *
 * Replaces the hand-rolled `public/sw.js` (cache "music-org-v6"). Rules that
 * MUST survive any refactor:
 *
 *   1. NEVER cache HTML or RSC payloads. Every page behind auth is
 *      user-specific; the Cache Storage is shared by every account that
 *      signs in on this browser, so a cached document is a cross-user PII
 *      leak primitive. Navigations + RSC fetches are `NetworkOnly`, with the
 *      static `/offline` page as the only fallback.
 *   2. `/api/*` is network-only (server actions too), except `/api/audio/*`
 *      which falls back to the IndexedDB `mmo-offline` blob store.
 *   3. `purge-caches` message from `lib/auth-client.ts` (sign-out) wipes
 *      every cache so the next user can't see the previous user's assets.
 */

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";
import { AUDIO_ROUTE, handleAudioRequest } from "./sw-offline-audio";

declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
        __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
}

declare const self: ServiceWorkerGlobalScope;

const networkOnly = new NetworkOnly();

/**
 * Routes are matched in order; these run BEFORE `defaultCache` so its
 * `NetworkFirst` "pages" / "pages-rsc" / "apis" / "others" entries never
 * see a document, an RSC payload or an API call.
 */
const mixaiRuntimeCaching: RuntimeCaching[] = [
    {
        // HTML documents + Next.js RSC / server-action requests → never cached (PII rule above).
        matcher: ({ request, sameOrigin }) =>
            sameOrigin &&
            (request.mode === "navigate" ||
                request.destination === "document" ||
                request.headers.get("RSC") === "1" ||
                request.headers.has("Next-Action") ||
                (request.headers.get("Accept") ?? "").includes("text/html")),
        handler: networkOnly,
    },
    {
        // Audio streams: network, then the IndexedDB offline copy.
        matcher: ({ url, sameOrigin }) => sameOrigin && AUDIO_ROUTE.test(url.pathname),
        handler: handleAudioRequest,
    },
    {
        // Everything else under /api is per-user JSON → network only.
        matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/"),
        handler: networkOnly,
    },
    ...defaultCache,
];

const serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    precacheOptions: { cleanupOutdatedCaches: true },
    skipWaiting: true,
    clientsClaim: true,
    disableDevLogs: true,
    runtimeCaching: mixaiRuntimeCaching,
    fallbacks: {
        entries: [
            {
                // Precached via `additionalPrecacheEntries` in serwist.config.mjs.
                url: "/offline",
                matcher({ request }) {
                    return request.destination === "document";
                },
            },
        ],
    },
});

serwist.addEventListeners();

// Drop the caches left behind by the pre-serwist worker ("music-org-v*").
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k.startsWith("music-org-")).map((k) => caches.delete(k))),
        ),
    );
});

// Sign-out hook from the page (`lib/auth-client.ts`). Wipe every cache so
// the next user signed in on this browser can't see the previous user's
// cached assets.
self.addEventListener("message", (event) => {
    if (event.data?.type !== "purge-caches") return;
    const port = event.ports?.[0];
    event.waitUntil(
        (async () => {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
            } finally {
                port?.postMessage({ ok: true });
            }
        })(),
    );
});

// ─── Push notifications ─────────────────────────────────────────────────────
// Server pushes a JSON payload encrypted under the user's subscription
// public key (Web Push protocol, RFC 8030). Payload shape:
//   { title: string, body?: string, icon?: string, badge?: string,
//     tag?: string, url?: string, actions?: NotificationAction[] }
interface PushPayload {
    title?: unknown;
    body?: unknown;
    icon?: unknown;
    badge?: unknown;
    tag?: unknown;
    url?: unknown;
    actions?: unknown;
}

self.addEventListener("push", (event) => {
    let data: PushPayload = {};
    try {
        data = (event.data?.json() as PushPayload) ?? {};
    } catch {
        // Some senders push plain text; fall back to a generic notification.
        data = { title: "MixAI", body: event.data?.text() || "" };
    }

    const title = typeof data.title === "string" && data.title.length > 0 ? data.title.slice(0, 200) : "MixAI";
    const body = typeof data.body === "string" ? data.body.slice(0, 500) : "";
    const tag = typeof data.tag === "string" ? data.tag : undefined;
    const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/";

    const options: NotificationOptions & { renotify?: boolean; actions?: unknown[] } = {
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
    const url: string = (event.notification.data as { url?: string } | undefined)?.url || "/";
    event.waitUntil(
        (async () => {
            const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            // Focus an existing same-origin window and navigate it instead of
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
        })(),
    );
});

self.addEventListener("pushsubscriptionchange", (event) => {
    // The browser rotated the subscription (e.g. key expired). The page picks
    // this up via the `pushsubscriptionchange` message and re-runs the
    // subscribe flow (`hooks/use-push-subscription.ts`).
    (event as ExtendableEvent).waitUntil(
        (async () => {
            const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            for (const client of allClients) {
                client.postMessage({ type: "pushsubscriptionchange" });
            }
        })(),
    );
});
