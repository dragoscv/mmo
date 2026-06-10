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

/** Credential lifetime in seconds (2h). The previous 24h window was excessive
 *  for what is effectively a bandwidth coupon against our coturn box —
 *  WebRTC sessions last minutes, and the client refreshes on demand. */
const TTL_SECONDS = 2 * 60 * 60;

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

    // Auth required. The HMAC-derived credential is a 2h bandwidth coupon against
    // our coturn box; serving it anonymously turns the relay into anyone's free
    // CDN. All in-app callers (remote-controller, live, webrtc-bridge) hit this
    // endpoint with same-origin cookies, so they're unaffected.
    const session = await auth().catch(() => null);
    if (!session?.user?.id) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

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
        // Browser-only cache; refresh shortly before expiry. Must NOT be
        // shared/CDN-cached — this is per-user bearer credentials.
        headers: { "Cache-Control": `private, max-age=${TTL_SECONDS - 600}` },
    });
}
