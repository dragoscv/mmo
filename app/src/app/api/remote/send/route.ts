import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { relay } from "@/lib/remote-relay";
import { requireSessionWithRate } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * POST endpoint to broadcast a remote sync message to all peers of the same user.
 *
 * Body: { senderId: string, message: SyncMessage }
 */
export async function POST(request: NextRequest) {
    // Sync messages are small (track changes, transport state) and the
    // legitimate cadence is sub-second on heavy mixing. 600/min/user
    // (10/sec) is generous; without it a malicious client floods every
    // peer of the user.
    const guard = await requireSessionWithRate(request, { bucket: "remote-send", windowMs: 60_000, max: 600 });
    if (guard.response) return guard.response;
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json() as { senderId?: string; message?: unknown };
    if (!body.senderId || !body.message) {
        return NextResponse.json({ error: "Missing senderId or message" }, { status: 400 });
    }
    if (typeof body.senderId !== "string" || body.senderId.length > 128) {
        return NextResponse.json({ error: "Invalid senderId" }, { status: 400 });
    }

    const data = JSON.stringify(body.message);
    // Size cap: relay fans out to every peer, so a 10 MB message is a
    // 10 MB egress burst PER PEER. Keep messages small; legitimate sync
    // payloads are <8 KB.
    if (data.length > 65_536) {
        return NextResponse.json({ error: "Message too large" }, { status: 413 });
    }
    relay.broadcast(body.senderId, session.user.id, data);

    return NextResponse.json({ ok: true });
}
