import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { relay } from "@/lib/remote-relay";

export const dynamic = "force-dynamic";

/**
 * POST endpoint to broadcast a remote sync message to all peers of the same user.
 *
 * Body: { senderId: string, message: SyncMessage }
 */
export async function POST(request: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json() as { senderId?: string; message?: unknown };
    if (!body.senderId || !body.message) {
        return NextResponse.json({ error: "Missing senderId or message" }, { status: 400 });
    }

    const data = JSON.stringify(body.message);
    relay.broadcast(body.senderId, session.user.id, data);

    return NextResponse.json({ ok: true });
}
