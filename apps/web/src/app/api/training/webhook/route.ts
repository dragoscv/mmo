import { NextRequest } from "next/server";
import { ingestTrainerEvent } from "@mmo/db";
import { timingSafeEqual } from "node:crypto";

/**
 * Trainer event webhook.
 *
 * The Python trainer POSTs here every N gradient steps + at sample +
 * checkpoint boundaries. Body is:
 *   {
 *     jobId: string,
 *     kind: 'started'|'step'|'sample'|'checkpoint'|'warning'|'error'|'finished',
 *     step?: number, loss?: number, evalLoss?: number,
 *     sampleUri?: string, checkpointUri?: string, weightsUri?: string,
 *     previewUri?: string, message?: string, actualCostUsd?: number,
 *   }
 *
 * Authentication: same `X-MMO-Trainer-Secret` header as the control
 * endpoint. The header is timing-safe-compared so a wrong secret leaks
 * no information about its length.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function checkTrainerSecret(req: NextRequest): boolean {
    const expected = process.env.MMO_TRAINER_SECRET ?? "";
    const got = req.headers.get("x-mmo-trainer-secret") ?? "";
    if (!expected || expected.length < 16) return false;
    if (got.length !== expected.length) return false;
    try {
        return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
    } catch {
        return false;
    }
}

export async function POST(req: NextRequest) {
    if (!checkTrainerSecret(req)) {
        return new Response("forbidden", { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as { jobId?: string } & Record<string, unknown>;
    if (!body || typeof body.jobId !== "string") {
        return new Response("invalid-body", { status: 400 });
    }
    const res = await ingestTrainerEvent(body.jobId, body);
    return new Response(JSON.stringify(res), {
        status: res.ok ? 200 : 400,
        headers: { "content-type": "application/json" },
    });
}
