/**
 * GET /api/turn-credentials
 *
 * Mints short-lived TURN credentials using the RFC "ephemeral REST" auth
 * pattern (https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00).
 *
 *   username = <unix-expiry>:<user-id>
 *   password = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))
 *
 * The coturn server validates by recomputing the same HMAC.  No per-user state
 * lives on the TURN box.
 *
 * Falls back to public Google STUN (UDP holepunch only) when TURN_HOST or
 * TURN_SHARED_SECRET aren't configured — useful for local dev.
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const PUBLIC_STUN: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];

/** Credential lifetime in seconds (24h). Re-fetch on the client well before expiry. */
const TTL_SECONDS = 24 * 60 * 60;

export async function GET() {
    const host = process.env.TURN_HOST;
    const secret = process.env.TURN_SHARED_SECRET;
    const realm = process.env.TURN_REALM;

    // No TURN configured → return STUN-only.  WebRTC will still work peer-to-peer
    // when both sides are on cone NATs (most home networks), but will fail across
    // symmetric NATs (most mobile carriers).
    if (!host || !secret) {
        return NextResponse.json({
            iceServers: PUBLIC_STUN,
            ttl: 0,
            mode: "stun-only",
        });
    }

    // Identify the requester so we can rate-limit on the TURN side via the
    // username component.  Anonymous fallback is fine — coturn cares about HMAC.
    const session = await auth().catch(() => null);
    const userId = session?.user?.id ?? "anon";

    const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const username = `${expiry}:${userId}`;
    const password = crypto
        .createHmac("sha1", secret)
        .update(username)
        .digest("base64");

    // Provide both UDP and TCP variants — TCP is a fallback when UDP is blocked.
    const iceServers: RTCIceServer[] = [
        ...PUBLIC_STUN,
        { urls: `stun:${host}` },
        {
            urls: [
                `turn:${host}?transport=udp`,
                `turn:${host}?transport=tcp`,
            ],
            username,
            credential: password,
        },
    ];

    return NextResponse.json({
        iceServers,
        ttl: TTL_SECONDS,
        mode: "turn",
        realm,
    }, {
        // Allow the browser to cache for 23h — refresh just before expiry.
        headers: { "Cache-Control": `private, max-age=${TTL_SECONDS - 3600}` },
    });
}
