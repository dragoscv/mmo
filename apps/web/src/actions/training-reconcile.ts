"use server";

/**
 * Vertex AI reconciler.
 *
 * Background sweep that catches up on training_jobs whose trainer
 * went silent. We list jobs that are still in {running, submitted, paused}
 * and whose last event is > N minutes old, then ask Vertex AI for the
 * job's terminal state. If the job has actually finished/failed in
 * Vertex without sending us a webhook, we synthesize a `finished` or
 * `error` event into training_events so the SSE stream wakes up and
 * the LoRA gets registered (when applicable).
 *
 * This is the safety net for: (a) Pub/Sub message loss, (b) trainer
 * crashes before the final webhook fires, (c) Vertex spot preemption.
 *
 * Cadence: meant to be called from a cron / scheduler every 60-300s.
 * The action itself is idempotent — re-running while a real webhook
 * arrives is fine (the event dedupes on (jobId, kind='finished')).
 */

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { auth } from "@/auth";
import { db } from "@/db";
import { trainingJobs, trainingEvents } from "@/db/schema-training";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { ingestTrainerEvent } from "@mmo/db";

const STALE_AFTER_MINUTES = 5;
const SCRIPT_PATH = path.resolve(process.cwd(), "..", "infra", "vertex", "status-job.py");

interface VertexStatus {
    state: string; // JOB_STATE_RUNNING, JOB_STATE_SUCCEEDED, JOB_STATE_FAILED, JOB_STATE_CANCELLED ...
    error?: string;
    outputUri?: string;
    weightsUri?: string;
}

async function getVertexJobStatus(jobName: string): Promise<VertexStatus | null> {
    try {
        await fsp.access(SCRIPT_PATH);
    } catch {
        // Status script isn't present yet — silently skip; the reconciler
        // becomes a no-op until ops drops the script in place.
        return null;
    }
    return await new Promise((resolve) => {
        const out: string[] = [];
        const err: string[] = [];
        const proc = spawn("python", [SCRIPT_PATH, "--job-name", jobName], {
            env: process.env as NodeJS.ProcessEnv,
        });
        proc.stdout.on("data", (d) => out.push(String(d)));
        proc.stderr.on("data", (d) => err.push(String(d)));
        proc.on("close", (code) => {
            if (code !== 0) {
                console.warn("[reconcile] status script failed", { jobName, stderr: err.join("") });
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(out.join("")) as VertexStatus);
            } catch (e) {
                console.warn("[reconcile] status script returned non-JSON", { jobName, e });
                resolve(null);
            }
        });
    });
}

export async function reconcileTrainingJobs(): Promise<{
    checked: number;
    reconciled: number;
    errors: string[];
}> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MINUTES * 60_000);

    const stale = await db
        .select({
            id: trainingJobs.id,
            externalJobName: trainingJobs.externalJobName,
            provider: trainingJobs.provider,
            status: trainingJobs.status,
            updatedAt: trainingJobs.updatedAt,
        })
        .from(trainingJobs)
        .where(
            and(
                inArray(trainingJobs.status, ["submitted", "running", "paused"]),
                isNotNull(trainingJobs.externalJobName),
                lt(trainingJobs.updatedAt, cutoff),
            ),
        )
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

        // Dedupe: don't insert another terminal event if one already exists.
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

    // Convenience metric: surface how many jobs we even looked at.
    return { checked: stale.length, reconciled, errors };
}

/** Cron entrypoint — `POST /api/training/reconcile` calls this. */
export async function reconcileTick(): Promise<void> {
    try {
        const res = await reconcileTrainingJobs();
        if (res.reconciled > 0 || res.errors.length > 0) {
            console.log("[reconcile] tick", res);
        }
    } catch (e) {
        console.error("[reconcile] tick failed", e);
    }
}

// Silence unused-import warnings for diagnostic SQL helpers we may want soon.
void sql;

/**
 * Session-gated wrapper for client UI use. The training page calls this
 * when it detects a job that hasn't received an event in N minutes — it
 * lets the user self-heal stuck jobs without us needing a cron in dev.
 * Rate-limited by the natural staleness gate inside `reconcileTrainingJobs`.
 */
export async function reconcileTrainingJobsForCurrentUser(): Promise<{
    checked: number;
    reconciled: number;
    errors: string[];
}> {
    const s = await auth();
    if (!s?.user?.id) throw new Error("Not signed in");
    return reconcileTrainingJobs();
}
