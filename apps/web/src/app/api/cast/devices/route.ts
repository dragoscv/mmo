/**
 * GET /api/cast/devices[?refresh=1]
 *
 * Merged DLNA + Home Assistant device list from the user's current
 * companion. The browser appends `{id:"chromecast:web"}` itself when the
 * Google Cast SDK reports availability — that marker never comes from here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { companionCast } from "@/lib/cast/companion-cast";

export async function GET(request: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
        const r = await companionCast.devices(request.nextUrl.searchParams.get("refresh") === "1");
        return NextResponse.json(r);
    } catch (e) {
        return NextResponse.json(
            { devices: [], haConfigured: false, error: e instanceof Error ? e.message : String(e) },
            { status: 503 },
        );
    }
}
