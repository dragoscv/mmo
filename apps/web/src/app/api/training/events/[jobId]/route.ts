import { auth } from "@/auth";
import { db } from "@/db";
import { trainingEvents, trainingJobs } from "@/db/schema-training";
import { and, eq, gt } from "drizzle-orm";

/**
 * SSE stream of training events for one job.
 *
 * The /training UI subscribes via `new EventSource(...)`. We poll the
 * `training_events` table every 1s; cheap because the row volume is
 * bounded (<10k per job) and the index on (job_id, created_at) is hit.
 *
 * Wire format (client must close the EventSource itself on `done`,
 * otherwise the browser auto-reconnects to a now-terminal job):
 *   event: job        (snapshot — at start + every time we see a new event)
 *   event: <kind>     (one per row of training_events, kind from the DB)
 *   event: done       (sent once when the job reaches a terminal status)
 *   : hb              (heartbeat comment, every HEARTBEAT_MS)
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 1000;
const HEARTBEAT_MS = 3_000;

function isTerminalStatus(s: string | null | undefined): boolean {
    return s === "succeeded" || s === "failed" || s === "cancelled";
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ jobId: string }> },
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return new Response("unauthorized", { status: 401 });

    const { jobId } = await params;

    // Auth scope: caller must own the job.
    const [job] = await db
        .select({ id: trainingJobs.id })
        .from(trainingJobs)
        .where(and(eq(trainingJobs.id, jobId), eq(trainingJobs.userId, userId)))
        .limit(1);
    if (!job) return new Response("not-found", { status: 404 });

    const encoder = new TextEncoder();
    let lastTs = new Date(0);

    const stream = new ReadableStream({
        async start(controller) {
            const send = (event: string, data: Record<string, unknown>) => {
                try {
                    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                } catch { /* closed */ }
            };
            const sendComment = (text: string) => {
                try { controller.enqueue(encoder.encode(`: ${text}\n\n`)); }
                catch { /* closed */ }
            };

            // Preamble — flush headers immediately so the browser receives
            // the response start (otherwise proxies / Node may buffer the
            // initial empty body and EventSource sees ERR_ABORTED).
            sendComment("hi");

            let cancelled = false;
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            const finish = () => {
                cancelled = true;
                if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
                try { controller.close(); } catch { /* already closed */ }
            };

            try {
                // Initial snapshot: latest job + last 200 events.
                const [j] = await db
                    .select()
                    .from(trainingJobs)
                    .where(eq(trainingJobs.id, jobId))
                    .limit(1);
                send("job", serializeJob(j));

                const initial = await db
                    .select()
                    .from(trainingEvents)
                    .where(eq(trainingEvents.jobId, jobId))
                    .orderBy(trainingEvents.createdAt)
                    .limit(200);
                for (const ev of initial) {
                    send(ev.kind, serializeEvent(ev));
                    if (ev.createdAt && ev.createdAt > lastTs) lastTs = ev.createdAt;
                }

                // If the job is already terminal at connect time, close the
                // stream gracefully with a `done` event so the client knows
                // not to auto-reconnect. (EventSource retries any HTTP
                // close including 200, so we MUST signal terminality.)
                if (isTerminalStatus(j?.status)) {
                    send("done", { reason: j?.status ?? "terminal" });
                    finish();
                    return;
                }
            } catch (err) {
                send("error", { message: err instanceof Error ? err.message : String(err) });
                send("done", { reason: "snapshot-error" });
                finish();
                return;
            }

            heartbeat = setInterval(() => {
                try { controller.enqueue(encoder.encode(`: hb\n\n`)); }
                catch { if (heartbeat) clearInterval(heartbeat); }
            }, HEARTBEAT_MS);

            const poll = async () => {
                while (!cancelled) {
                    try {
                        const newer = await db
                            .select()
                            .from(trainingEvents)
                            .where(and(eq(trainingEvents.jobId, jobId), gt(trainingEvents.createdAt, lastTs)))
                            .orderBy(trainingEvents.createdAt)
                            .limit(100);
                        for (const ev of newer) {
                            send(ev.kind, serializeEvent(ev));
                            if (ev.createdAt && ev.createdAt > lastTs) lastTs = ev.createdAt;
                        }
                        const terminalEvent = newer.find(
                            (ev) => ev.kind === "finished" || ev.kind === "error" || ev.kind === "cancelled",
                        );
                        if (terminalEvent || newer.length > 0) {
                            // Push a fresh job snapshot any time we saw new events.
                            const [updated] = await db
                                .select()
                                .from(trainingJobs)
                                .where(eq(trainingJobs.id, jobId))
                                .limit(1);
                            if (updated) send("job", serializeJob(updated));
                            if (terminalEvent || isTerminalStatus(updated?.status)) {
                                send("done", { reason: terminalEvent?.kind ?? updated?.status ?? "terminal" });
                                finish();
                                return;
                            }
                        }
                    } catch { /* swallow — next tick will retry */ }
                    await new Promise((r) => setTimeout(r, POLL_MS));
                }
            };
            void poll();

            request.signal.addEventListener("abort", finish);
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-store, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}

function serializeJob(j: typeof trainingJobs.$inferSelect | undefined): Record<string, unknown> {
    if (!j) return {};
    return {
        id: j.id,
        status: j.status,
        currentStep: j.currentStep,
        lastLoss: j.lastLoss,
        lastEvalLoss: j.lastEvalLoss,
        latestSampleUri: j.latestSampleUri,
        latestCheckpointUri: j.latestCheckpointUri,
        controlSignal: j.controlSignal,
        updatedAt: j.updatedAt?.toISOString(),
    };
}

function serializeEvent(ev: typeof trainingEvents.$inferSelect): Record<string, unknown> {
    return {
        id: ev.id,
        kind: ev.kind,
        step: ev.step,
        message: ev.message,
        data: ev.data,
        source: ev.source,
        createdAt: ev.createdAt?.toISOString(),
    };
}
