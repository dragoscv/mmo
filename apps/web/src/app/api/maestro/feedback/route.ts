import { NextRequest } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { auth } from "@/auth";
import { db } from "@/db";
import { syncLog } from "@/db/schema";

/**
 * Direct user-driven Maestro feedback endpoint.
 *
 * The chat dock surfaces a small "Report this" button next to failed tool
 * calls and tool errors. That button POSTs here with the failing context.
 * Persisted to data/maestro-feedback/issues.jsonl + mirrored into syncLog
 * (entity='maestroFeedback', op='upsert') so it shows in the audit trail.
 */

export const runtime = "nodejs";

interface FeedbackBody {
    sessionId?: string;
    messageId?: string;
    toolCallId?: string;
    title?: string;
    summary?: string;
    severity?: "low" | "medium" | "high" | "blocker";
    category?: "bug" | "ux" | "gap" | "performance" | "data";
    context?: Record<string, unknown>;
    userNote?: string;
    pageUrl?: string;
}

export async function POST(req: NextRequest) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return new Response(JSON.stringify({ error: "Not signed in" }), {
            status: 401,
            headers: { "content-type": "application/json" },
        });
    }
    const body = (await req.json().catch(() => ({}))) as FeedbackBody;
    const entry = {
        ts: new Date().toISOString(),
        userId,
        sessionId: body.sessionId ?? null,
        messageId: body.messageId ?? null,
        toolCallId: body.toolCallId ?? null,
        title: body.title ?? "User-reported Maestro issue",
        summary: body.summary ?? body.userNote ?? "(no summary)",
        severity: body.severity ?? "medium",
        category: body.category ?? "bug",
        context: body.context ?? null,
        userNote: body.userNote ?? null,
        pageUrl: body.pageUrl ?? null,
        source: "ui-report" as const,
    };
    // eslint-disable-next-line no-console
    console.warn("[maestro-feedback:ui]", JSON.stringify(entry));
    try {
        const dir = path.join(process.cwd(), "data", "maestro-feedback");
        await fsp.mkdir(dir, { recursive: true });
        const file = path.join(dir, "issues.jsonl");
        await fsp.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[maestro-feedback] file write failed", err);
    }
    try {
        await db.insert(syncLog).values({
            userId,
            entity: "maestroFeedback",
            entityId: randomUUID(),
            op: "upsert",
            payload: entry as object,
            originDeviceId: null,
        });
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ ok: true, filed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}
