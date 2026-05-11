/**
 * Client-side sign-out helper that purges the Service Worker's HTML / asset
 * caches before redirecting. Without this, the next user to sign in on the
 * same browser could be served the previous user's cached navigation HTML
 * (a cross-user PII leak).
 *
 * The companion service worker (`public/sw.js`) listens for the
 * `{ type: "purge-caches" }` message and runs `caches.keys() →
 * caches.delete(...)` for every known cache before this resolves.
 */

import { signOut, type SignOutParams } from "next-auth/react";

export async function signOutAndPurge(params?: SignOutParams<true>): Promise<void> {
    try {
        if (typeof navigator !== "undefined" && navigator.serviceWorker) {
            const reg = await navigator.serviceWorker.getRegistration();
            const sw = reg?.active;
            if (sw) {
                await new Promise<void>((resolve) => {
                    const channel = new MessageChannel();
                    const timer = setTimeout(() => resolve(), 1000);
                    channel.port1.onmessage = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                    sw.postMessage({ type: "purge-caches" }, [channel.port2]);
                });
            }
            // Belt-and-braces: also wipe from the page side in case the SW
            // ack timed out or there's no controller (first-load edge case).
            if (typeof caches !== "undefined") {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
            }
        }
    } catch {
        // Cache wipe is defence-in-depth — never block sign-out on it.
    }
    await signOut(params);
}
