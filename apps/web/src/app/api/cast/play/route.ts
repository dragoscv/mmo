/**
 * POST /api/cast/play
 * Body: { deviceId, media: {type:"video",fileId} | {type:"track",trackId}, startSec?, subtitleIndex? }
 *
 * HTTP twin of the `castToDevice` server action (for the PWA / native shells).
 */

import { NextResponse, type NextRequest } from "next/server";
import { castToDevice } from "@/actions/cast";

export async function POST(request: NextRequest) {
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const r = await castToDevice(body as Parameters<typeof castToDevice>[0]);
    if (!r.ok) {
        const status = r.error === "Not signed in" ? 401 : r.error === "Invalid input" ? 400 : 502;
        return NextResponse.json({ error: r.error }, { status });
    }
    return NextResponse.json(r.data);
}
