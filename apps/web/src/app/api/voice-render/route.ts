/**
 * GET /api/voice-render?voiceId=...&renderId=...
 *
 * Server-side proxy that streams a rendered WAV from the companion
 * to the signed-in user's browser. Exists so the device token never
 * touches the client.
 *
 * Auth: relies on the Auth.js session — only the asset owner can fetch.
 * (Voices live on the companion machine and are scoped to one device,
 *  so cross-user access is already blocked at the companion edge, but
 *  we still enforce a session here for defense in depth.)
 */

import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
// Streaming + range proxying — never cache.
export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]+$/;

export async function GET(req: NextRequest): Promise<Response> {
    const session = await auth();
    if (!session?.user?.id) {
        return new Response(JSON.stringify({ error: "Not signed in" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }
    const url = new URL(req.url);
    const voiceId = url.searchParams.get("voiceId") ?? "";
    const renderId = url.searchParams.get("renderId") ?? "";
    if (!ID_RE.test(voiceId) || !ID_RE.test(renderId)) {
        return new Response(JSON.stringify({ error: "bad-params" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    const link = await getCompanionLink();
    if (!link) {
        return new Response(JSON.stringify({ error: "companion-unreachable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
        });
    }
    const target = `${link.apiUrl}/voice/${encodeURIComponent(voiceId)}/render/${encodeURIComponent(renderId)}`;
    const headers: Record<string, string> = {
        "X-Device-Token": link.token,
        "X-User-Id": link.userId,
    };
    const range = req.headers.get("range");
    if (range) headers["Range"] = range;

    const upstream = await fetch(target, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
    });

    if (!upstream.ok && upstream.status !== 206) {
        const text = await upstream.text().catch(() => "");
        return new Response(JSON.stringify({ error: "companion-error", status: upstream.status, body: text.slice(0, 500) }), {
            status: upstream.status,
            headers: { "Content-Type": "application/json" },
        });
    }
    const out = new Headers();
    out.set("Content-Type", "audio/wav");
    out.set("Cache-Control", "private, max-age=60");
    const passthrough = ["content-length", "content-range", "accept-ranges"];
    for (const h of passthrough) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
}
