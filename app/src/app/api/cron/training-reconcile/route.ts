/**
 * GET /api/training/reconcile — Vercel Cron entry.
 *
 * Vercel Cron jobs only support GET. The HMAC-protected POST handler at
 * `/api/training/reconcile` (route.ts) handles machine-to-machine calls
 * from Cloud Scheduler / external cron. This GET handler is an
 * additional path that accepts either:
 *  • The Vercel Cron secret (`Authorization: Bearer $CRON_SECRET`) — see
 *    https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 *  • The same `X-MMO-Trainer-Secret` HMAC header used by the POST route.
 *
 * Wired in vercel.json:
 *   { "crons": [{ "path": "/api/training/reconcile", "schedule": "*\/2 * * * *" }] }
 */

import { NextRequest } from "next/server";
import { reconcileTrainingJobs } from "@/actions/training-reconcile";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
    // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
    const cronSecret = process.env.CRON_SECRET ?? "";
    if (cronSecret) {
        const auth = req.headers.get("authorization") ?? "";
        if (auth === `Bearer ${cronSecret}`) return true;
    }
    // Fallback: shared trainer secret (machine-to-machine).
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

export async function GET(req: NextRequest) {
    if (!authorized(req)) {
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
