/**
 * Browser-facing SSE proxy for the companion's `POST /library/usb/copy`.
 *
 * The companion is reachable directly from the browser at the loopback
 * URL, but the device token used to authenticate is encrypted at rest
 * and only materialised server-side via `getCompanionLink()`. So we
 * forward the request from this Next.js Route Handler — auth happens
 * server-side, the SSE stream gets piped back to the browser without
 * any buffering.
 */

import { auth } from "@/auth";
import { copyTracksToUsb, getCompanionLink, type UsbCopyEvent } from "@/lib/companion-library";

export const dynamic = "force-dynamic";

interface Body {
    trackIds: unknown;
    destination: unknown;
    musicSubdir?: unknown;
}

export async function POST(request: Request): Promise<Response> {
    const session = await auth();
    if (!session?.user?.id) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }

    let body: Body;
    try {
        body = (await request.json()) as Body;
    } catch {
        return new Response(JSON.stringify({ error: "invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const ids = Array.isArray(body.trackIds)
        ? body.trackIds.filter((n): n is number => Number.isInteger(n) && n > 0)
        : [];
    if (ids.length === 0) {
        return new Response(JSON.stringify({ error: "trackIds: non-empty array required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (typeof body.destination !== "string" || body.destination.trim() === "") {
        return new Response(JSON.stringify({ error: "destination required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    const musicSubdir =
        typeof body.musicSubdir === "string" ? body.musicSubdir : undefined;

    const link = await getCompanionLink();
    if (!link) {
        return new Response(JSON.stringify({ error: "companion not linked" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    const encoder = new TextEncoder();
    const abortCtrl = new AbortController();
    request.signal.addEventListener("abort", () => abortCtrl.abort());

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (event: UsbCopyEvent) => {
                try {
                    controller.enqueue(
                        encoder.encode(
                            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                        ),
                    );
                } catch {
                    // Stream closed by client.
                }
            };
            try {
                for await (const ev of copyTracksToUsb(
                    link,
                    { trackIds: ids, destination: body.destination as string, musicSubdir },
                    abortCtrl.signal,
                )) {
                    send(ev);
                    if (ev.type === "done") break;
                }
            } catch (err) {
                try {
                    controller.enqueue(
                        encoder.encode(
                            `event: error\ndata: ${JSON.stringify({
                                error: err instanceof Error ? err.message : String(err),
                            })}\n\n`,
                        ),
                    );
                } catch {
                    // Stream already closed.
                }
            } finally {
                try { controller.close(); } catch { /* already closed */ }
            }
        },
        cancel() {
            abortCtrl.abort();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
