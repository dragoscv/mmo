import { NextRequest } from "next/server";
import { consumeControlSignalForTrainer, patchControlSignal } from "@/actions/training";
import { auth } from "@/auth";
import { timingSafeEqual } from "node:crypto";

/**
 * Trainer ↔ app control-signal channel.
 *
 * GET — called by the Python trainer every N steps. HMAC-authenticated
 * via the `X-MMO-Trainer-Secret` header (compared against
 * `MMO_TRAINER_SECRET` env). Returns the current `controlSignal` JSON;
 * one-shot fields like `evalNow` are atomically cleared inside
 * `consumeControlSignalForTrainer`.
 *
 * PATCH — called from the app (Maestro tool or UI) to write a new patch.
 * Uses normal session auth (no header).
 *
 * The whole point of this endpoint is that the trainer never holds a
 * database connection: it speaks plain HTTPS to /api/training/control.
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

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ jobId: string }> },
) {
    if (!checkTrainerSecret(req)) {
        return new Response("forbidden", { status: 403 });
    }
    const { jobId } = await params;
    const signal = await consumeControlSignalForTrainer(jobId);
    if (signal === null) {
        return new Response("not-found", { status: 404 });
    }
    return new Response(JSON.stringify({ ok: true, controlSignal: signal }), {
        headers: { "content-type": "application/json" },
    });
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ jobId: string }> },
) {
    const session = await auth();
    if (!session?.user?.id) return new Response("unauthorized", { status: 401 });
    const { jobId } = await params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const res = await patchControlSignal(jobId, body);
    return new Response(JSON.stringify(res), {
        status: res.ok ? 200 : 400,
        headers: { "content-type": "application/json" },
    });
}
