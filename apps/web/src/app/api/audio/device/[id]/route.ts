import { NextRequest, NextResponse } from "next/server";
import { companionLibrary, getCompanionLink, getCompanionLinkForDevice } from "@/lib/companion-library";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const trackId = parseInt(id);

    if (isNaN(trackId)) {
        return NextResponse.json({ error: "Invalid track ID" }, { status: 400 });
    }

    const link = await getCompanionLink();
    if (!link) {
        return NextResponse.json({ error: "Companion not connected" }, { status: 503 });
    }
    const track = await companionLibrary.getTrackById(link, trackId);

    if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }

    // No device = local track, redirect to normal audio endpoint
    if (!track.deviceId) {
        return NextResponse.redirect(new URL(`/api/audio/${trackId}`, request.url));
    }

    // CRITICAL: track.deviceId comes from the user's companion DB, which is
    // user-controlled. Resolve it through the userId-scoped helper so a user
    // cannot point a track row at another tenant's device and have us proxy
    // their bytes back (with the victim's bearer token attached — token-bearing
    // SSRF + cross-tenant audio disclosure). The helper enforces
    // `where deviceId = ? and userId = session.user.id`.
    const target = await getCompanionLinkForDevice(track.deviceId);
    if (!target) {
        return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    // Defence-in-depth on the path we forward to the companion. The companion
    // is supposed to validate this too, but a stray control char or null byte
    // in our outgoing URL is never legitimate and just enlarges the attack
    // surface for any current or future companion-side parser bug.
    const rawPath = track.filepath;
    if (
        typeof rawPath !== "string" || rawPath.length === 0 ||
        rawPath.length > 4096 || /[\x00-\x1F]/.test(rawPath)
    ) {
        return NextResponse.json({ error: "Invalid track path" }, { status: 400 });
    }

    // Proxy the audio request to the companion device
    try {
        const encodedPath = encodeURIComponent(rawPath);
        const headers: HeadersInit = {
            "X-Device-Token": target.token,
        };

        // Forward range header for seeking
        const range = request.headers.get("Range");
        if (range) {
            headers["Range"] = range;
        }

        const resp = await fetch(`${target.apiUrl}/audio/${encodedPath}`, {
            headers,
            signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
            return NextResponse.json(
                { error: `Device returned ${resp.status}` },
                { status: resp.status }
            );
        }

        // Forward the response directly
        const responseHeaders = new Headers();
        const forwardHeaders = [
            "Content-Type", "Content-Length", "Content-Range",
            "Accept-Ranges", "Content-Disposition",
        ];
        for (const h of forwardHeaders) {
            const v = resp.headers.get(h);
            if (v) responseHeaders.set(h, v);
        }

        return new NextResponse(resp.body, {
            status: resp.status,
            headers: responseHeaders,
        });
    } catch (err) {
        return NextResponse.json(
            { error: `Device unreachable: ${err instanceof Error ? err.message : "Unknown"}` },
            { status: 503 }
        );
    }
}
