/**
 * Module-level cache of ICE servers fetched from /api/turn-credentials.
 * Used by useWebRTCAudioStream so multiple hosts share one in-flight request.
 */

interface CredentialResponse {
    iceServers: RTCIceServer[];
    ttl: number;
    mode: "stun-only" | "turn";
}

interface CacheEntry {
    iceServers: RTCIceServer[];
    expiresAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<RTCIceServer[]> | null = null;

const FALLBACK_STUN: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];

export async function fetchIceServers(): Promise<RTCIceServer[]> {
    if (typeof window === "undefined") return FALLBACK_STUN;

    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.iceServers;
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            const res = await fetch("/api/turn-credentials", { credentials: "same-origin" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as CredentialResponse;
            const ttlMs = Math.max(60_000, (data.ttl - 600) * 1000); // refresh 10 min before expiry
            cache = {
                iceServers: data.iceServers,
                // STUN-only responses come back with ttl=0 — re-check periodically anyway
                expiresAt: now + (data.ttl > 0 ? ttlMs : 5 * 60_000),
            };
            return data.iceServers;
        } catch (e) {
            console.warn("[ICE] failed to fetch credentials, falling back to STUN only", e);
            return FALLBACK_STUN;
        } finally {
            inflight = null;
        }
    })();

    return inflight;
}

/** Clear the cache — call on auth state change. */
export function invalidateIceServers() {
    cache = null;
}
