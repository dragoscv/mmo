/**
 * POST /api/training/reconcile — invoked by a cron (Cloud Scheduler / GH
 * Actions / Cron service) every 60-300 seconds. Sweeps stale jobs and
 * synthesizes terminal events for jobs where the trainer webhook went
 * missing.
 *
 * Auth: shared HMAC secret (`X-MMO-Trainer-Secret`) — the same secret used
 * by the webhook endpoint. No session — this is machine-to-machine.
 */

import { NextRequest } from "next/server";
import { reconcileTrainingJobs } from "@/actions/training-reconcile";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkSecret(req: NextRequest): boolean {
    const expected = process.env.MMO_TRAINER_SECRET ?? "";
    if (!expected) return false;
    const got = req.headers.get("x-mmo-trainer-secret") ?? "";
    if (got.length !== expected.length) return false;
    try {
        return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    } catch {
        return false;
    }
}

export async function POST(req: NextRequest) {
    if (!checkSecret(req)) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
        });
    }
    try {
        const result = await reconcileTrainingJobs();
        return new Response(JSON.stringify({ ok: true, ...result }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Reconcile failed";
        return new Response(JSON.stringify({ ok: false, error: message }), {
            status: 500,
            headers: { "content-type": "application/json" },
        });
    }
}
