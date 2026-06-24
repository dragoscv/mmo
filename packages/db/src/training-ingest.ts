/**
 * Shared trainer-facing data-plane logic (machine-to-machine).
 *
 * Ported from apps/web/src/actions/training.ts. These two functions are the
 * ONLY training operations the Python trainer (Vertex) calls directly:
 *   - ingestTrainerEvent          ← POST /api/training/webhook
 *   - consumeControlSignalForTrainer ← GET /api/training/control/[jobId]
 *
 * They are pure DB logic (no Vertex submission, no NextAuth), so they live
 * here and are run identically by the web route and the gateway via the
 * injected `db` (setDb at startup). The web app keeps the rich
 * user-facing training Server Actions; it now re-exports these two from
 * here to avoid drift.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDb } from "./runtime-db";
import { loraAssets, trainingDatasets, trainingEvents, trainingJobs } from "./schema-training";
import type * as schemaCore from "./schema";
import type * as schemaTraining from "./schema-training";

type TrainingDb = PostgresJsDatabase<typeof schemaCore & typeof schemaTraining>;
const db: TrainingDb = new Proxy({} as TrainingDb, {
    get(_t, prop) {
        return (getDb() as Record<string | symbol, unknown>)[prop];
    },
});

// ─── Types (mirrored from actions/training.ts) ──────────────────────────

export interface ControlSignal {
    updatedAt?: string;
    updatedBy?: string;
    learningRate?: number | null;
    datasetItemWeights?: Record<string, number> | null;
    earlyStop?: boolean | null;
    evalPrompt?: string | null;
    evalNow?: boolean | null;
    pause?: boolean | null;
    note?: string | null;
}

interface TrainConfigLike {
    baseModel?: string;
    rank?: number;
}

/**
 * GET control-signal channel — polled by the trainer every N steps.
 * Clears one-shot fields (evalNow) atomically. Returns null if no job.
 */
export async function consumeControlSignalForTrainer(jobId: string): Promise<ControlSignal | null> {
    const [job] = await db
        .select()
        .from(trainingJobs)
        .where(eq(trainingJobs.id, jobId))
        .limit(1);
    if (!job) return null;
    const sig = (job.controlSignal ?? {}) as ControlSignal;
    if (sig.evalNow) {
        const cleared: ControlSignal = { ...sig, evalNow: false };
        await db
            .update(trainingJobs)
            .set({ controlSignal: cleared, updatedAt: new Date() })
            .where(eq(trainingJobs.id, jobId));
        return cleared; // exact parity with the original web action
    }
    return sig;
}

// ─── Trainer event ingestion ────────────────────────────────────────────

const TrainerEventSchema = z.object({
    kind: z.enum([
        "started", "step", "sample", "checkpoint", "warning", "error",
        "finished", "cancelled", "controlPatch",
    ]),
    step: z.number().int().min(0).optional(),
    message: z.string().max(2000).optional(),
    loss: z.number().optional(),
    evalLoss: z.number().optional(),
    learningRate: z.number().optional(),
    sampleUri: z.string().optional(),
    checkpointUri: z.string().optional(),
    weightsUri: z.string().optional(),
    previewUri: z.string().optional(),
    outputUri: z.string().optional(),
    actualCostUsd: z.number().optional(),
    error: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
});

export type TrainerEventInput = z.infer<typeof TrainerEventSchema>;

/** Called by the webhook route — never by user code. Updates cached
 *  progress fields, appends to the event log, auto-registers the LoRA on
 *  successful finish. */
export async function ingestTrainerEvent(
    jobId: string,
    raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const parsed = TrainerEventSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid-event: ${parsed.error.message}` };
    const ev = parsed.data;
    const [job] = await db
        .select()
        .from(trainingJobs)
        .where(eq(trainingJobs.id, jobId))
        .limit(1);
    if (!job) return { ok: false, error: "job-not-found" };

    const update: Partial<typeof trainingJobs.$inferInsert> = { updatedAt: new Date() };
    if (ev.kind === "started") {
        update.status = "running";
        update.startedAt = new Date();
    }
    if (ev.kind === "step" && typeof ev.step === "number") {
        update.currentStep = ev.step;
        if (typeof ev.loss === "number") update.lastLoss = ev.loss;
        if (typeof ev.evalLoss === "number") update.lastEvalLoss = ev.evalLoss;
        const history = ((job.lossHistory ?? []) as Array<{ step: number; loss: number }>).slice(-499);
        if (typeof ev.loss === "number") {
            history.push({ step: ev.step, loss: ev.loss });
            update.lossHistory = history;
        }
    }
    if (ev.kind === "sample" && ev.sampleUri) update.latestSampleUri = ev.sampleUri;
    if (ev.kind === "checkpoint" && ev.checkpointUri) update.latestCheckpointUri = ev.checkpointUri;
    if (ev.kind === "finished") {
        update.status = "succeeded";
        update.finishedAt = new Date();
        if (typeof ev.actualCostUsd === "number") update.actualCostUsd = ev.actualCostUsd;
    }
    if (ev.kind === "cancelled") {
        update.status = "cancelled";
        update.finishedAt = new Date();
    }
    if (ev.kind === "error") {
        update.status = "failed";
        update.error = ev.error ?? ev.message ?? "trainer-error";
        update.finishedAt = new Date();
    }

    await db.update(trainingJobs).set(update).where(eq(trainingJobs.id, jobId));
    await db.insert(trainingEvents).values({
        jobId,
        kind: ev.kind,
        step: ev.step ?? null,
        message: ev.message ?? null,
        source: "trainer",
        data: ev as unknown as Record<string, unknown>,
    });

    if (ev.kind === "finished" && job.kind.endsWith("-lora")) {
        const dataPayload = (ev.data ?? {}) as Record<string, unknown>;
        const weightsUri = (ev.weightsUri
            ?? dataPayload["weightsUri"]
            ?? (raw as Record<string, unknown>)["weightsUri"]) as unknown;
        const previewUri = (ev.previewUri
            ?? dataPayload["previewUri"]
            ?? (raw as Record<string, unknown>)["previewUri"]) as unknown;
        if (typeof weightsUri === "string" && weightsUri.startsWith("gs://")) {
            const weightsUriStr: string = weightsUri;
            let tagsArr: string[] = [];
            if (job.datasetId) {
                const [ds] = await db
                    .select({ tagHistogram: trainingDatasets.tagHistogram })
                    .from(trainingDatasets)
                    .where(eq(trainingDatasets.id, job.datasetId))
                    .limit(1);
                if (ds?.tagHistogram) {
                    tagsArr = Object.entries(ds.tagHistogram)
                        .sort(([, a], [, b]) => (b as number) - (a as number))
                        .slice(0, 8)
                        .map(([k]) => k.toLowerCase());
                }
            }
            const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
            const triggerToken = slug ? `<${slug}>` : null;
            const cfg = (job.config ?? {}) as TrainConfigLike;
            await db
                .insert(loraAssets)
                .values({
                    userId: job.userId,
                    scope: job.kind === "style-lora" ? "shared" : "user",
                    kind: job.kind === "style-lora" ? "style" : "user",
                    jobId: job.id,
                    name: job.name,
                    description: job.description ?? null,
                    triggerToken,
                    baseModel: cfg.baseModel,
                    rank: cfg.rank,
                    weightsUri: weightsUriStr,
                    previewUri: typeof previewUri === "string" ? previewUri : null,
                    tags: tagsArr,
                    evalLoss: job.lastEvalLoss,
                } satisfies Partial<typeof loraAssets.$inferInsert> as typeof loraAssets.$inferInsert)
                .onConflictDoNothing();
        }
    }

    return { ok: true };
}
