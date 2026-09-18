/**
 * POST /api/cast/command
 * Body: { deviceId, action: play|pause|stop|seek|volume_set|volume_mute|next|previous, value? }
 */

import { NextResponse, type NextRequest } from "next/server";
import { castCommand } from "@/actions/cast";

export async function POST(request: NextRequest) {
    let body: unknown;
    try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const r = await castCommand(body as Parameters<typeof castCommand>[0]);
    if (!r.ok) {
        const status = r.error === "Not signed in" ? 401 : r.error === "Invalid input" ? 400 : 502;
        return NextResponse.json({ error: r.error }, { status });
    }
    return NextResponse.json({ ok: true });
}
