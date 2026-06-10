"use client";

import { useEffect, useState } from "react";

const COMPANION_BASE = process.env.NEXT_PUBLIC_COMPANION_BASE_URL || "http://127.0.0.1:17899";

interface DiscordState {
    connected: boolean;
    clientId?: string | null;
    activity?: { title?: string; subtitle?: string } | null;
}

/**
 * React hook that mirrors the companion's Discord RPC state into the UI.
 * The companion broadcasts state + presence updates over an SSE stream;
 * this hook just listens and exposes the current snapshot.
 */
export function useDiscordPresence(): DiscordState {
    const [state, setState] = useState<DiscordState>({ connected: false });

    useEffect(() => {
        if (typeof window === "undefined") return;
        const token = window.localStorage.getItem("mmo-device-token") ?? "";
        const userId = window.localStorage.getItem("mmo-user-id") ?? "";
        if (!token || !userId) return;
        const url = `${COMPANION_BASE}/video/discord/stream?t=${encodeURIComponent(token)}&u=${encodeURIComponent(userId)}`;
        let es: EventSource | null = null;
        try { es = new EventSource(url); } catch { return; }
        es.addEventListener("state", (ev) => {
            try { setState((cur) => ({ ...cur, ...JSON.parse((ev as MessageEvent).data) })); } catch { /* ignore */ }
        });
        es.addEventListener("presence", (ev) => {
            try {
                const data = JSON.parse((ev as MessageEvent).data);
                setState((cur) => ({ ...cur, activity: { title: data?.title, subtitle: data?.subtitle } }));
            } catch { /* ignore */ }
        });
        es.onerror = () => { /* browser auto-retries */ };
        return () => { es?.close(); };
    }, []);

    return state;
}
