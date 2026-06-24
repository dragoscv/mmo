/**
 * Trainer-facing machine-to-machine endpoints (Vertex Python trainer).
 * Moved off Vercel — these are M2M (HMAC shared secret), not browser routes.
 *
 *   POST /api/training/webhook            ← trainer progress events
 *   GET  /api/training/control/:jobId     ← trainer polls control signal
 *
 * The PATCH half of control (user-driven, NextAuth session) stays on the
 * web app. Logic is the shared @mmo/db implementation — identical to what
 * the web route runs.
 */

import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { consumeControlSignalForTrainer, ingestTrainerEvent } from "@mmo/db";

function checkTrainerSecret(c: Context): boolean {
    const expected = process.env.MMO_TRAINER_SECRET ?? "";
    const got = c.req.header("x-mmo-trainer-secret") ?? "";
    if (!expected || expected.length < 16) return false;
    if (got.length !== expected.length) return false;
    try {
        return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
    } catch {
        return false;
    }
}

export async function handleTrainingWebhook(c: Context) {
    if (!checkTrainerSecret(c)) return c.text("forbidden", 403);
    const body = await c.req.json().catch(() => ({})) as { jobId?: string } & Record<string, unknown>;
    if (!body || typeof body.jobId !== "string") return c.text("invalid-body", 400);
    const res = await ingestTrainerEvent(body.jobId, body);
    return c.json(res, res.ok ? 200 : 400);
}

export async function handleTrainingControlGet(c: Context) {
    if (!checkTrainerSecret(c)) return c.text("forbidden", 403);
    const jobId = c.req.param("jobId");
    if (!jobId) return c.text("missing-jobId", 400);
    const signal = await consumeControlSignalForTrainer(jobId);
    if (signal === null) return c.text("not-found", 404);
    return c.json({ ok: true, controlSignal: signal });
}
