import { NextResponse } from "next/server";
import { getCompanionLinkForDevice } from "@/lib/companion-library";
import { resolveStreamSource } from "@/lib/cloud-library";

/**
 * Stream a track's audio by proxying to whichever of the user's devices holds
 * the file (resolved via track_sources, cloud source of truth). Used by both
 * /api/audio/[id] (transparent fallback) and /api/audio/device/[id].
 *
 * `trackId` may be the cloud serial id or the companion track id — the
 * resolver matches either. userId-scoped, so a user can never point at another
 * tenant's device (token-bearing SSRF / cross-tenant audio disclosure).
 */
export async function streamTrackFromDevice(
    request: Request,
    trackId: number,
): Promise<NextResponse> {
    const source = await resolveStreamSource(trackId);
    if (!source) {
        return NextResponse.json({ error: "No source device for this track" }, { status: 404 });
    }
    if (!source.online) {
        return NextResponse.json({ error: "Source device offline" }, { status: 503 });
    }

    const target = await getCompanionLinkForDevice(source.deviceId);
    if (!target) {
        return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    const rawPath = source.filepath;
    if (
        typeof rawPath !== "string" || rawPath.length === 0 ||
        rawPath.length > 4096 || /[\x00-\x1F]/.test(rawPath)
    ) {
        return NextResponse.json({ error: "Invalid track path" }, { status: 400 });
    }

    try {
        const encodedPath = encodeURIComponent(rawPath);
        const headers: HeadersInit = { "X-Device-Token": target.token };
        const range = request.headers.get("Range");
        if (range) headers["Range"] = range;

        const resp = await fetch(`${target.apiUrl}/audio/${encodedPath}`, {
            headers,
            signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
            return NextResponse.json({ error: `Device returned ${resp.status}` }, { status: resp.status });
        }

        const responseHeaders = new Headers();
        for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Content-Disposition"]) {
            const v = resp.headers.get(h);
            if (v) responseHeaders.set(h, v);
        }

        return new NextResponse(resp.body, { status: resp.status, headers: responseHeaders });
    } catch (err) {
        return NextResponse.json(
            { error: `Device unreachable: ${err instanceof Error ? err.message : "Unknown"}` },
            { status: 503 },
        );
    }
}
