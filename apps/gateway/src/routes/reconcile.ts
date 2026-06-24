/**
 * Training reconciler — catches up jobs whose Vertex trainer went silent.
 *
 * Replaces the Vercel-cron + spawn(python status-job.py) approach. On Cloud
 * Run we query the Vertex AI REST API directly using the instance metadata
 * server's access token (the gateway's service account needs
 * roles/aiplatform.viewer). Triggered by Cloud Scheduler:
 *
 *   POST /api/internal/reconcile   (HMAC: X-MMO-Trainer-Secret)
 *
 * Terminal Vertex states are synthesized into trainer events via the shared
 * ingestTrainerEvent so the SSE stream + LoRA registration fire exactly as
 * if the trainer had posted a final webhook.
 */

import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { trainingJobs, trainingEvents } from "@mmo/db/schema-training";
import { ingestTrainerEvent } from "@mmo/db";

const STALE_AFTER_MINUTES = 5;

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

interface VertexStatus {
    state: string;
    error?: string;
    outputUri?: string;
    weightsUri?: string;
}

let cachedToken: { token: string; exp: number } | null = null;
async function metadataAccessToken(): Promise<string | null> {
    if (cachedToken && cachedToken.exp > Date.now() + 30_000) return cachedToken.token;
    try {
        const res = await fetch(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            { headers: { "Metadata-Flavor": "Google" } },
        );
        if (!res.ok) return null;
        const j = await res.json() as { access_token: string; expires_in: number };
        cachedToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
        return j.access_token;
    } catch {
        return null;
    }
}

/** Parse `projects/P/locations/L/customJobs/ID` → region L. */
function regionFromJobName(jobName: string): string | null {
    const m = /locations\/([^/]+)\//.exec(jobName);
    return m ? m[1]! : null;
}

async function getVertexJobStatus(jobName: string): Promise<VertexStatus | null> {
    const region = regionFromJobName(jobName);
    if (!region) return null;
    const token = await metadataAccessToken();
    if (!token) return null;
    try {
        const res = await fetch(
            `https://${region}-aiplatform.googleapis.com/v1/${jobName}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) return null;
        const job = await res.json() as {
            state?: string;
            error?: { message?: string };
            jobSpec?: { workerPoolSpecs?: Array<{ containerSpec?: { args?: string[] } }> };
        };
        const out: VertexStatus = { state: job.state ?? "JOB_STATE_UNKNOWN" };
        if (job.error?.message) out.error = job.error.message;
        for (const w of job.jobSpec?.workerPoolSpecs ?? []) {
            const args = w.containerSpec?.args ?? [];
            const i = args.indexOf("--output-uri");
            if (i >= 0 && i + 1 < args.length) {
                out.outputUri = args[i + 1];
                out.weightsUri = args[i + 1]!.replace(/\/+$/, "") + "/lora.safetensors";
            }
        }
        return out;
    } catch {
        return null;
    }
}

export async function reconcileTrainingJobs(): Promise<{ checked: number; reconciled: number; errors: string[] }> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000);
    const stale = await db
        .select({
            id: trainingJobs.id,
            externalJobName: trainingJobs.externalJobName,
            provider: trainingJobs.provider,
        })
        .from(trainingJobs)
        .where(and(
            inArray(trainingJobs.status, ["submitted", "running", "paused"]),
            isNotNull(trainingJobs.externalJobName),
            lt(trainingJobs.updatedAt, cutoff),
        ))
        .limit(50);

    const errors: string[] = [];
    let reconciled = 0;
    for (const job of stale) {
        if (job.provider !== "vertex" || !job.externalJobName) continue;
        const status = await getVertexJobStatus(job.externalJobName);
        if (!status) continue;
        let mapped: "finished" | "error" | "cancelled" | null = null;
        if (status.state.endsWith("SUCCEEDED")) mapped = "finished";
        else if (status.state.endsWith("FAILED")) mapped = "error";
        else if (status.state.endsWith("CANCELLED")) mapped = "cancelled";
        if (!mapped) continue;

        const [already] = await db
            .select({ id: trainingEvents.id })
            .from(trainingEvents)
            .where(and(
                eq(trainingEvents.jobId, job.id),
                inArray(trainingEvents.kind, ["finished", "error", "cancelled"]),
            ))
            .limit(1);
        if (already) continue;

        try {
            await ingestTrainerEvent(job.id, {
                kind: mapped,
                message: mapped === "error"
                    ? `Reconciler: ${status.error ?? "Vertex job failed"}`
                    : "Reconciler: detected terminal state from Vertex",
                weightsUri: status.weightsUri,
                outputUri: status.outputUri,
            });
            reconciled++;
        } catch (e) {
            errors.push(`${job.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { checked: stale.length, reconciled, errors };
}

export async function handleReconcile(c: Context) {
    if (!checkTrainerSecret(c)) return c.text("forbidden", 403);
    const res = await reconcileTrainingJobs();
    if (res.reconciled > 0 || res.errors.length > 0) console.log("[reconcile]", res);
    return c.json(res);
}
