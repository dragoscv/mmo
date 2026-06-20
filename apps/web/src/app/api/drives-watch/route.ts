/**
 * Browser-facing SSE proxy for the companion's `GET /library/drives/watch`.
 *
 * Pushes the annotated drive list whenever drives are plugged/unplugged or
 * their rekordbox status changes. The device token is materialised
 * server-side via `getCompanionLink()`; the SSE stream is piped back to the
 * browser unbuffered.
 */

import { getCompanionLink } from "@/lib/companion-library";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const link = await getCompanionLink();
    if (!link) {
        return new Response(JSON.stringify({ error: "companion not linked" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort());

    let upstream: Response;
    try {
        upstream = await fetch(`${link.apiUrl}/library/drives/watch`, {
            headers: {
                "X-Device-Token": link.token,
                "X-User-Id": link.userId,
                Accept: "text/event-stream",
            },
            cache: "no-store",
            signal: abort.signal,
        });
    } catch (err) {
        return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : "companion unreachable" }),
            { status: 502, headers: { "Content-Type": "application/json" } },
        );
    }

    if (!upstream.ok || !upstream.body) {
        return new Response(JSON.stringify({ error: `companion responded ${upstream.status}` }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
        });
    }

    return new Response(upstream.body, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
