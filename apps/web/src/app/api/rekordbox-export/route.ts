/**
 * Browser-facing SSE proxy for the companion's
 * `POST /library/rekordbox/export`.
 *
 * The companion writes a true plug-and-play CDJ/XDJ USB (Contents/ audio +
 * export.pdb + exportExt.pdb + USBANLZ analysis). The device token is only
 * materialised server-side via `getCompanionLink()`, so we forward the
 * request from this Route Handler and pipe the SSE stream back without
 * buffering.
 */

import { auth } from "@/auth";
import {
    getCompanionLink,
    rekordboxExport,
    type RekordboxExportEvent,
    type RekordboxAutoCrate,
    type RekordboxTranscode,
} from "@/lib/companion-library";

export const dynamic = "force-dynamic";

interface Body {
    trackIds?: unknown;
    playlistIds?: unknown;
    destination?: unknown;
    autoCrates?: unknown;
    transcode?: unknown;
    writeAnlz?: unknown;
}

const json = (data: unknown, status: number) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });

export async function POST(request: Request): Promise<Response> {
    const session = await auth();
    if (!session?.user?.id) return json({ error: "unauthorized" }, 401);

    let body: Body;
    try {
        body = (await request.json()) as Body;
    } catch {
        return json({ error: "invalid JSON body" }, 400);
    }

    if (typeof body.destination !== "string" || body.destination.trim() === "") {
        return json({ error: "destination required" }, 400);
    }

    const trackIds = Array.isArray(body.trackIds)
        ? body.trackIds.filter((n): n is number => Number.isInteger(n) && n > 0)
        : undefined;
    const playlistIds = Array.isArray(body.playlistIds)
        ? body.playlistIds.filter((n): n is number => Number.isInteger(n) && n > 0)
        : undefined;
    const autoCrates = Array.isArray(body.autoCrates)
        ? body.autoCrates.filter((c): c is RekordboxAutoCrate =>
            c === "genre" || c === "bpm" || c === "key")
        : undefined;
    const transcode = (["none", "incompatible", "all"] as const).includes(
        body.transcode as RekordboxTranscode,
    )
        ? (body.transcode as RekordboxTranscode)
        : undefined;
    const writeAnlz = typeof body.writeAnlz === "boolean" ? body.writeAnlz : undefined;

    const link = await getCompanionLink();
    if (!link) return json({ error: "companion not linked" }, 400);

    const encoder = new TextEncoder();
    const abortCtrl = new AbortController();
    request.signal.addEventListener("abort", () => abortCtrl.abort());

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (event: RekordboxExportEvent) => {
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
                for await (const ev of rekordboxExport(
                    link,
                    {
                        destination: (body.destination as string).trim(),
                        trackIds,
                        playlistIds,
                        autoCrates,
                        transcode,
                        writeAnlz,
                    },
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
