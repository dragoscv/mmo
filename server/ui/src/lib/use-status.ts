import { useCallback, useEffect, useRef, useState } from "react";
import { mmo, type CompanionStatus } from "./ipc";

const STATUS_POLL_MS = 3000;

/**
 * Companion status (auth, port, user) — source of truth is main's `get-status`.
 * Re-fetched on `status-changed` / `auth-invalidated` pushes, plus a 3 s
 * safety-net poll so the UI converges even if a push is dropped during a
 * renderer reload race (ported 1:1 from the legacy renderer).
 */
export function useStatus() {
    const [status, setStatus] = useState<CompanionStatus | null>(null);
    const [invalidatedReason, setInvalidatedReason] = useState<string | null>(null);
    const alive = useRef(true);

    const refresh = useCallback(async () => {
        if (!mmo) return null;
        try {
            const s = await mmo.getStatus();
            if (alive.current) setStatus(s);
            return s;
        } catch {
            /* ignore transient IPC errors */
            return null;
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        void refresh();
        if (!mmo) return;
        const offStatus = mmo.onStatusChanged(() => void refresh());
        const offAuth = mmo.onAuthInvalidated((data) => {
            console.warn("[auth] device pairing invalidated by cloud:", data?.reason);
            setInvalidatedReason(data?.reason ?? "unknown");
            void refresh();
        });
        const timer = window.setInterval(() => void refresh(), STATUS_POLL_MS);
        return () => {
            alive.current = false;
            offStatus();
            offAuth();
            window.clearInterval(timer);
        };
    }, [refresh]);

    // A successful pairing clears the "unpaired by cloud" banner.
    useEffect(() => {
        if (status?.authenticated) setInvalidatedReason(null);
    }, [status?.authenticated]);

    return { status, refresh, invalidatedReason };
}
