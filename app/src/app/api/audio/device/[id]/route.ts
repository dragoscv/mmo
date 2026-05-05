import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";

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

    // Get the device
    const deviceRows = await db
        .select()
        .from(devices)
        .where(eq(devices.id, track.deviceId))
        .limit(1);
    const device = deviceRows[0];

    if (!device) {
        return NextResponse.json({ error: "Device not found" }, { status: 404 });
    }

    // Proxy the audio request to the companion device
    try {
        const encodedPath = encodeURIComponent(track.filepath);
        const headers: HeadersInit = {
            "X-Device-Token": device.token,
        };

        // Forward range header for seeking
        const range = request.headers.get("Range");
        if (range) {
            headers["Range"] = range;
        }

        const resp = await fetch(`${device.apiUrl}/audio/${encodedPath}`, {
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
