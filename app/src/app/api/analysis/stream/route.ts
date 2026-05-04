import { analysisManager } from "@/lib/analysis-manager";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            const send = (data: Record<string, unknown>) => {
                try {
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
                    );
                } catch {
                    // Stream closed
                }
            };

            // Send initial state
            send({ ...analysisManager.getStatus() } as Record<string, unknown>);

            // Subscribe to live events
            const unsubscribe = analysisManager.subscribe((event) => {
                send(event as unknown as Record<string, unknown>);
            });

            // Heartbeat every 15s to keep connection alive
            const heartbeat = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(`: heartbeat\n\n`));
                } catch {
                    clearInterval(heartbeat);
                }
            }, 15000);

            // Cleanup on client disconnect
            request.signal.addEventListener("abort", () => {
                unsubscribe();
                clearInterval(heartbeat);
                try {
                    controller.close();
                } catch {
                    // Already closed
                }
            });
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
