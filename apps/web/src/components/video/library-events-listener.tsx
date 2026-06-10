"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const COMPANION_BASE = process.env.NEXT_PUBLIC_COMPANION_BASE_URL || "http://127.0.0.1:17899";

/**
 * Subscribe to companion library-change events and trigger a router
 * refresh whenever new video files appear (or disappear). Falls back
 * silently when the companion is unreachable — the page still works.
 *
 * Mount once at the top of /watch.
 */
export function LibraryEventsListener() {
    const router = useRouter();
    useEffect(() => {
        if (typeof window === "undefined") return;
        const token = window.localStorage.getItem("mmo-device-token") ?? "";
        const userId = window.localStorage.getItem("mmo-user-id") ?? "";
        if (!token || !userId) return;
        const url = `${COMPANION_BASE}/video/watch/events?t=${encodeURIComponent(token)}&u=${encodeURIComponent(userId)}`;
        let es: EventSource | null = null;
        try {
            es = new EventSource(url);
        } catch {
            return;
        }
        es.addEventListener("change", () => router.refresh());
        es.onerror = () => { /* keep alive; browser retries */ };
        return () => { es?.close(); };
    }, [router]);
    return null;
}
