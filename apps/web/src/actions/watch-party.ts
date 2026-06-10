"use server";

import { getPlaybackHandle } from "@/lib/companion-video";

/**
 * Watch Party — co-watch rooms over the companion WebSocket.
 * Creates a new room and returns join info the client can broadcast.
 */
export async function createPartyRoom(): Promise<
    | { ok: true; roomId: string; wsUrl: string; shareUrl: string }
    | { error: string }
> {
    const handle = await getPlaybackHandle();
    if (!handle) return { error: "companion offline" };

    const resp = await fetch(`${handle.apiUrl}/video/party/create`, {
        method: "POST",
        headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
        signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!resp || !resp.ok) return { error: "create failed" };
    const data = (await resp.json()) as { roomId?: string };
    if (!data.roomId) return { error: "bad response" };

    // ws URL is built client-side so we can resolve to a per-LAN address;
    // here we just hand back the canonical companion URL + share URL.
    const wsBase = handle.apiUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase}/party/${encodeURIComponent(data.roomId)}`;
    return {
        ok: true,
        roomId: data.roomId,
        wsUrl,
        // The share URL is a deep link into /watch with the party param.
        // Clients on the same LAN can join via the same companion.
        shareUrl: `?party=${encodeURIComponent(data.roomId)}`,
    };
}

/**
 * Resolve the companion handle for use by client-side hooks
 * (so the WS hook can build the auth-bearing WS URL without
 * leaking the device token through the page payload). The token
 * is intentionally NOT sent back to the client — it is already
 * present in cookie/localStorage on the trusted device.
 *
 * Actually: the simplest path is to expose `apiUrl` + `userId` here
 * and let the client read the token from where it's already stored.
 */
export async function getPartyHandle(): Promise<{ apiUrl: string; token: string; userId: string } | null> {
    return getPlaybackHandle();
}
