import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { relay } from "@/lib/remote-relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * SSE endpoint for remote sync.
 * Each connected client receives messages broadcast by other peers of the same user.
 *
 * Query params:
 *   peerId - the client's unique peer ID (required)
 */
export async function GET(request: NextRequest) {
    const session = await auth();
    if (!session?.user?.id) {
        return new Response("Unauthorized", { status: 401 });
    }

    const peerId = request.nextUrl.searchParams.get("peerId");
    if (!peerId) {
        return new Response("Missing peerId", { status: 400 });
    }
    // Bound the client-supplied id: it ends up as a Map key + log field.
    if (peerId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(peerId)) {
        return new Response("Invalid peerId", { status: 400 });
    }

    const userId = session.user.id;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            // Register this client with the relay
            relay.add({
                id: peerId,
                userId,
                writer: null as unknown as WritableStreamDefaultWriter<Uint8Array>,
                controller,
            });

            // Send initial keepalive
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`: connected\n\n`));
        },
        cancel() {
            relay.remove(userId, peerId);
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
