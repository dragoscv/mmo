"use server";

/**
 * Training jobs — server actions.
 *
 * Lives between Maestro (lib/maestro/tools.ts), the /training UI, and the
 * Python trainer running on Vertex. The trainer never imports this file;
 * it talks to the HTTP API at /api/training/*, which delegates here.
 *
 * Design notes:
 *  - All writes are auth-scoped. `userId` is the caller's session id.
 *  - Submission persists a `training_jobs` row BEFORE shelling out to the
 *    Vertex SDK, then patches `externalJobName` on success. That way a
 *    crash mid-submit leaves a `pending`/`failed` row instead of an
 *    invisible orphan job in GCP.
 *  - Budget enforcement: monthly cap from env (`MMO_TRAINING_BUDGET_USD`,
 *    default $500). Before submit we sum `estimated_cost_usd` of jobs
 *    whose `created_at` is in the current calendar month and refuse if
 *    the new job would push it over.
 *  - Status reconciliation: we don't poll Vertex from inside this file.
 *    The `/api/training/cron/reconcile` route (called every minute by
 *    Cloud Scheduler) imports `reconcileVertexJobs` from
 *    actions/training-reconcile.ts.
 */

import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/auth";
import { db } from "@/db";
import { syncLog } from "@/db/schema";
import {
    loraAssets,
    trainingDatasets,
    trainingEvents,
    trainingJobs,
} from "@/db/schema-training";
import { submitAceStepLoraTrainingVertex, submitConductorTrainingVertex } from "@/actions/generate";
import { machineTypeForAccelerator } from "@/lib/training/machine-types";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";

/** Cap is configurable per environment; falls back to $500/mo. */
function monthlyBudgetUsd(): number {
    const raw = Number.parseFloat(process.env.MMO_TRAINING_BUDGET_USD ?? "500");
    return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

async function appendSync(
    userId: string,
    entity: string,
    entityId: string,
    op: "upsert" | "delete",
    payload: Record<string, unknown> | null,
) {
    await db.insert(syncLog).values({
        userId,
        entity,
        entityId,
        op,
        payload: payload as object | null,
        originDeviceId: null,
    });
}

// ─── Types ──────────────────────────────────────────────────────────────

export type TrainingJobKind =
    | "style-lora"
    | "user-lora"
    | "conductor-sft"
    | "conductor-dpo"
    | "acestep-dpo"
    | "stem-aware";

export type TrainingProvider = "vertex" | "local" | "runpod";

export type TrainingStatus =
    | "pending"
    | "submitted"
    | "running"
    | "paused"
    | "succeeded"
    | "failed"
    | "cancelled";

export interface TrainConfig {
    baseModel: string;
    machineType: string;
    acceleratorType: string;
    acceleratorCount: number;
    spot: boolean;
    datasetUri: string;
    outputUri: string;
    maxSteps: number;
    rank: number;
    learningRate: number;
    batchSize: number;
    warmupSteps: number;
    evalEverySteps: number;
    checkpointEverySteps: number;
    evalPrompt: string;
    seed: number;
    extraEnv?: Record<string, string>;
}

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

export interface TrainingJobDto {
    id: string;
    userId: string;
    datasetId: string | null;
    kind: TrainingJobKind;
    provider: TrainingProvider;
    externalJobName: string | null;
    consoleUrl: string | null;
    name: string;
    description: string | null;
    config: TrainConfig;
    controlSignal: ControlSignal;
    currentStep: number;
    lastLoss: number | null;
    lastEvalLoss: number | null;
    lossHistory: Array<{ step: number; loss: number }>;
    latestSampleUri: string | null;
    latestCheckpointUri: string | null;
    status: TrainingStatus;
    error: string | null;
    estimatedCostUsd: number | null;
    actualCostUsd: number | null;
    maxRuntimeHours: number;
    createdBy: "user" | "maestro" | "system";
    submittedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

function toJobDto(row: typeof trainingJobs.$inferSelect): TrainingJobDto {
    return {
        id: row.id,
        userId: row.userId,
        datasetId: row.datasetId,
        kind: row.kind as TrainingJobKind,
        provider: row.provider as TrainingProvider,
        externalJobName: row.externalJobName,
        consoleUrl: row.consoleUrl,
        name: row.name,
        description: row.description,
        config: row.config as TrainConfig,
        controlSignal: (row.controlSignal ?? {}) as ControlSignal,
        currentStep: row.currentStep,
        lastLoss: row.lastLoss,
        lastEvalLoss: row.lastEvalLoss,
        lossHistory: (row.lossHistory ?? []) as Array<{ step: number; loss: number }>,
        latestSampleUri: row.latestSampleUri,
        latestCheckpointUri: row.latestCheckpointUri,
        status: row.status as TrainingStatus,
        error: row.error,
        estimatedCostUsd: row.estimatedCostUsd,
        actualCostUsd: row.actualCostUsd,
        maxRuntimeHours: row.maxRuntimeHours,
        createdBy: row.createdBy as "user" | "maestro" | "system",
        submittedAt: row.submittedAt?.toISOString() ?? null,
        startedAt: row.startedAt?.toISOString() ?? null,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        createdAt: (row.createdAt ?? new Date()).toISOString(),
        updatedAt: (row.updatedAt ?? new Date()).toISOString(),
    };
}

// ─── Cost model ─────────────────────────────────────────────────────────

/** Rough hourly rates ($/hr) used by Maestro to pre-flight cost.
 *  Numbers are conservative (slightly above on-demand) so we never
 *  surprise the user. Update when GCP changes pricing. */
const HOURLY_RATES_USD: Record<string, { onDemand: number; spot: number }> = {
    "NVIDIA_A100_80GB": { onDemand: 3.67, spot: 1.10 },
    "NVIDIA_A100_40GB": { onDemand: 2.93, spot: 0.88 },
    "NVIDIA_L4": { onDemand: 0.65, spot: 0.20 },
    "NVIDIA_TESLA_T4": { onDemand: 0.45, spot: 0.14 },
};

/** Tokens/sec on each accelerator for ACE-Step LoRA — empirical, from
 *  internal benchmarks. Used to translate `maxSteps` → wall-time → cost. */
const STEPS_PER_HOUR: Record<string, number> = {
    "NVIDIA_A100_80GB": 1800,
    "NVIDIA_A100_40GB": 1600,
    "NVIDIA_L4": 700,
    "NVIDIA_TESLA_T4": 400,
};

export async function estimateJobCostUsd(cfg: TrainConfig): Promise<{ hours: number; usd: number }> {
    const rate = HOURLY_RATES_USD[cfg.acceleratorType];
    const stepsPerHour = STEPS_PER_HOUR[cfg.acceleratorType] ?? 800;
    if (!rate) return { hours: 0, usd: 0 };
    const hours = cfg.maxSteps / stepsPerHour;
    const hourly = cfg.spot ? rate.spot : rate.onDemand;
    return { hours, usd: hourly * hours * cfg.acceleratorCount };
}

/** Sum estimated_cost_usd of this user's training jobs created in the
 *  current calendar month — used to enforce the monthly cap. */
export async function getMonthlySpendUsd(userId: string): Promise<number> {
    const firstOfMonth = new Date();
    firstOfMonth.setUTCDate(1);
    firstOfMonth.setUTCHours(0, 0, 0, 0);
    const rows = await db
        .select({ cost: trainingJobs.estimatedCostUsd })
        .from(trainingJobs)
        .where(
            and(
                eq(trainingJobs.userId, userId),
                gte(trainingJobs.createdAt, firstOfMonth),
            ),
        );
    return rows.reduce((acc, r) => acc + (r.cost ?? 0), 0);
}

// ─── Genre training planner ─────────────────────────────────────────────

export interface GenreTrainingPlanEntry {
    genre: string;
    trackCount: number;
    /** min(perGenreCap, trackCount) — what the dataset would actually use. */
    suggestedLimit: number;
    /** Rough cost on the default L4-spot pairing at 100 steps × rank 16. */
    estCostUsd: number;
    /** True when trackCount >= minTracks — i.e. worth training on. */
    eligible: boolean;
}

/** Scan the user's library (via companion `/stats`) and return a
 *  per-genre training plan: genres with enough tracks to train a
 *  meaningful style-LoRA, sorted by track count. Cost estimate
 *  assumes L4 spot, 100 steps, rank 16 (the proven smoke-test config). */
export async function proposeGenreTrainingPlan(opts?: {
    minTracks?: number;
    perGenreCap?: number;
    topN?: number;
}): Promise<{ ok: true; plan: GenreTrainingPlanEntry[]; totalLibrary: number } | { ok: false; error: string }> {
    const minTracks = opts?.minTracks ?? 100;
    const perGenreCap = opts?.perGenreCap ?? 300;
    const topN = opts?.topN ?? 10;

    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "no-companion-link" };
    let stats;
    try {
        stats = await companionLibrary.getStats(link);
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Cost reference: L4-spot @ $0.20/hr × (100 / 700) hr × 1 accel
    const cfgRef: TrainConfig = {
        baseModel: "ACE-Step/ACE-Step-v1-3.5B",
        machineType: "g2-standard-12",
        acceleratorType: "NVIDIA_L4",
        acceleratorCount: 1,
        spot: true,
        datasetUri: "",
        outputUri: "",
        maxSteps: 100,
        rank: 16,
        learningRate: 1e-4,
        batchSize: 1,
        warmupSteps: 0,
        evalEverySteps: 50,
        checkpointEverySteps: 50,
        evalPrompt: "",
        seed: 42,
    };
    const refCost = (await estimateJobCostUsd(cfgRef)).usd;

    const plan = stats.genreStats
        .filter((g) => g.genre && g.genre !== "Unknown")
        .map<GenreTrainingPlanEntry>((g) => ({
            genre: g.genre,
            trackCount: g.count,
            suggestedLimit: Math.min(perGenreCap, g.count),
            estCostUsd: Number(refCost.toFixed(3)),
            eligible: g.count >= minTracks,
        }))
        .sort((a, b) => b.trackCount - a.trackCount)
        .slice(0, topN);

    return { ok: true, plan, totalLibrary: stats.total };
}

// ─── Defaults per job kind ──────────────────────────────────────────────

const KIND_DEFAULTS: Record<TrainingJobKind, Partial<TrainConfig>> = {
    "style-lora": {
        baseModel: "ACE-Step/ACE-Step-v1-3.5B",
        acceleratorType: "NVIDIA_A100_40GB",
        machineType: "a2-highgpu-1g",
        acceleratorCount: 1,
        spot: true,
        maxSteps: 5000,
        rank: 32,
        learningRate: 1e-4,
        batchSize: 1,
        warmupSteps: 100,
        evalEverySteps: 200,
        checkpointEverySteps: 500,
        seed: 42,
    },
    "user-lora": {
        baseModel: "ACE-Step/ACE-Step-v1-3.5B",
        acceleratorType: "NVIDIA_L4",
        machineType: "g2-standard-12",
        acceleratorCount: 1,
        spot: true,
        maxSteps: 2000,
        rank: 16,
        learningRate: 1e-4,
        batchSize: 1,
        warmupSteps: 50,
        evalEverySteps: 100,
        checkpointEverySteps: 250,
        seed: 42,
    },
    "conductor-sft": {
        baseModel: "Qwen/Qwen2.5-3B-Instruct",
        acceleratorType: "NVIDIA_A100_40GB",
        machineType: "a2-highgpu-1g",
        acceleratorCount: 1,
        spot: true,
        maxSteps: 3000,
        rank: 16,
        learningRate: 2e-4,
        batchSize: 4,
        warmupSteps: 100,
        evalEverySteps: 200,
        checkpointEverySteps: 500,
        seed: 42,
    },
    "conductor-dpo": {
        baseModel: "Qwen/Qwen2.5-3B-Instruct",
        acceleratorType: "NVIDIA_A100_40GB",
        machineType: "a2-highgpu-1g",
        acceleratorCount: 1,
        spot: true,
        maxSteps: 1500,
        rank: 16,
        learningRate: 5e-6,
        batchSize: 2,
        warmupSteps: 50,
        evalEverySteps: 100,
        checkpointEverySteps: 250,
        seed: 42,
    },
    "acestep-dpo": {
        baseModel: "ACE-Step/ACE-Step-v1-3.5B",
        acceleratorType: "NVIDIA_A100_40GB",
        machineType: "a2-highgpu-1g",
        acceleratorCount: 1,
        spot: true,
        maxSteps: 2000,
        rank: 32,
        learningRate: 5e-6,
        batchSize: 1,
        warmupSteps: 50,
        evalEverySteps: 100,
        checkpointEverySteps: 250,
        seed: 42,
    },
    "stem-aware": {
        baseModel: "ACE-Step/ACE-Step-v1-3.5B",
        acceleratorType: "NVIDIA_A100_40GB",
        machineType: "a2-highgpu-1g",
        acceleratorCount: 1,
        spot: true,
        maxSteps: 4000,
        rank: 32,
        learningRate: 1e-4,
        batchSize: 1,
        warmupSteps: 100,
        evalEverySteps: 200,
        checkpointEverySteps: 500,
        seed: 42,
    },
};

// ─── Submit ─────────────────────────────────────────────────────────────

const SubmitInputSchema = z.object({
    kind: z.enum(["style-lora", "user-lora", "conductor-sft", "conductor-dpo", "acestep-dpo", "stem-aware"]),
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    datasetId: z.string().optional(),
    datasetUri: z.string().startsWith("gs://").optional(),
    outputUri: z.string().startsWith("gs://").optional(),
    config: z
        .object({
            baseModel: z.string().optional(),
            machineType: z.string().optional(),
            acceleratorType: z.string().optional(),
            acceleratorCount: z.number().int().min(1).max(8).optional(),
            spot: z.boolean().optional(),
            maxSteps: z.number().int().min(100).max(50000).optional(),
            rank: z.number().int().min(4).max(128).optional(),
            learningRate: z.number().positive().optional(),
            batchSize: z.number().int().min(1).max(64).optional(),
            warmupSteps: z.number().int().min(0).max(2000).optional(),
            evalEverySteps: z.number().int().min(10).max(2000).optional(),
            checkpointEverySteps: z.number().int().min(10).max(5000).optional(),
            evalPrompt: z.string().max(500).optional(),
            seed: z.number().int().optional(),
        })
        .optional(),
    maxRuntimeHours: z.number().min(0.5).max(48).optional(),
    createdBy: z.enum(["user", "maestro", "system"]).optional(),
    /** If true, skip the budget guard. Reserved for `user` initiator. */
    overrideBudget: z.boolean().optional(),
});

export type SubmitTrainingJobInput = z.infer<typeof SubmitInputSchema>;

export type SubmitResult =
    | { ok: true; job: TrainingJobDto }
    | { ok: false; error: string; estimateUsd?: number; spentUsd?: number };

export async function submitTrainingJob(rawInput: SubmitTrainingJobInput): Promise<SubmitResult> {
    const userId = await uid();
    const parsed = SubmitInputSchema.safeParse(rawInput);
    if (!parsed.success) return { ok: false, error: `invalid-input: ${parsed.error.message}` };
    const input = parsed.data;

    // 1. Resolve dataset URIs. Either dataset row (preferred) or raw gs:// uris.
    let datasetUri = input.datasetUri ?? "";
    let outputUri = input.outputUri ?? "";
    if (input.datasetId) {
        const [ds] = await db
            .select()
            .from(trainingDatasets)
            .where(eq(trainingDatasets.id, input.datasetId))
            .limit(1);
        if (!ds) return { ok: false, error: "dataset-not-found" };
        if (ds.scope === "user" && ds.userId !== userId) {
            return { ok: false, error: "dataset-forbidden" };
        }
        if (!ds.gcsUri) return { ok: false, error: "dataset-not-materialized" };
        datasetUri = ds.gcsUri;
        // Auto-derive an output URI under the same dataset prefix so callers
        // can submit with just `datasetId`. Layout: gs://<bucket>/ds-<id>/output/
        if (!outputUri) {
            // datasetUri is e.g. gs://bucket/ds-<id>/dataset/ ; strip trailing
            // "dataset/" segment and append "output/".
            outputUri = datasetUri.replace(/\/dataset\/?$/, "/") + "output/";
            if (!outputUri.startsWith("gs://")) {
                outputUri = `gs://${process.env.GCS_TRAINING_BUCKET ?? "mmo-training-prod"}/ds-${input.datasetId}/output/`;
            }
        }
    }
    if (!datasetUri || !outputUri) {
        return { ok: false, error: "dataset-and-output-uri-required" };
    }

    // 2. Merge kind defaults + user overrides into a sealed TrainConfig.
    const defaults = KIND_DEFAULTS[input.kind] as TrainConfig;
    const cfg: TrainConfig = {
        ...defaults,
        ...(input.config ?? {}),
        datasetUri,
        outputUri,
        evalPrompt: input.config?.evalPrompt ?? defaults.evalPrompt ?? "energetic melodic techno, 124 BPM, A minor, dreamy synths, [Intro][Verse][Drop]",
    } as TrainConfig;
    // Auto-correct machineType when user overrides acceleratorType but not machineType
    if (input.config?.acceleratorType && !input.config?.machineType) {
        cfg.machineType = machineTypeForAccelerator(cfg.acceleratorType);
    }

    // 3. Cost guard.
    const { hours, usd } = await estimateJobCostUsd(cfg);
    if (!input.overrideBudget) {
        const spent = await getMonthlySpendUsd(userId);
        const cap = monthlyBudgetUsd();
        if (spent + usd > cap) {
            return {
                ok: false,
                error: "monthly-budget-exceeded",
                estimateUsd: Math.round(usd * 100) / 100,
                spentUsd: Math.round(spent * 100) / 100,
            };
        }
    }
    const maxRuntimeHours = input.maxRuntimeHours ?? Math.max(1, Math.ceil(hours * 1.5));

    // 4. Insert pending row up-front so submit failures stay visible.
    const [row] = await db
        .insert(trainingJobs)
        .values({
            userId,
            datasetId: input.datasetId ?? null,
            kind: input.kind,
            provider: "vertex",
            name: input.name,
            description: input.description ?? null,
            config: cfg,
            controlSignal: {},
            estimatedCostUsd: Math.round(usd * 100) / 100,
            maxRuntimeHours,
            createdBy: input.createdBy ?? "user",
            status: "pending",
        })
        .returning();
    await db.insert(trainingEvents).values({
        jobId: row.id,
        kind: "submitted",
        source: input.createdBy === "maestro" ? "maestro" : "user",
        message: `Job ${input.name} (${input.kind}) submitted. Est. ${hours.toFixed(1)}h, $${usd.toFixed(2)}.`,
        data: { estimateUsd: usd, hours, cfg },
    });
    await appendSync(userId, "trainingJob", row.id, "upsert", { id: row.id, kind: input.kind, status: "pending" });

    // 5. Shell out to the existing Vertex submitter. Translate kind→target
    //    parameters (`acestep-dpo` and `stem-aware` reuse the same trainer
    //    image with extra env vars; conductor uses a separate image which
    //    isn't built yet — see PLAN.md §11).
    if (input.kind === "conductor-sft" || input.kind === "conductor-dpo") {
        const submission = await submitConductorTrainingVertex({
            expName: row.id,
            datasetUri: cfg.datasetUri,
            outputUri: cfg.outputUri,
            mode: input.kind === "conductor-sft" ? "sft" : "dpo",
            maxSteps: cfg.maxSteps,
            rank: cfg.rank,
            spot: cfg.spot,
            jobId: row.id,
            appUrl: process.env.MMO_APP_URL,
        });
        if (!submission.ok) {
            await db
                .update(trainingJobs)
                .set({ status: "failed", error: submission.error, updatedAt: new Date() })
                .where(eq(trainingJobs.id, row.id));
            await db.insert(trainingEvents).values({
                jobId: row.id,
                kind: "error",
                message: `Vertex conductor submit failed: ${submission.error}`,
                data: {},
                source: "vertex",
            });
            return { ok: false, error: submission.error };
        }
        const [updated] = await db
            .update(trainingJobs)
            .set({
                status: "submitted",
                externalJobName: submission.jobName,
                externalJobId: submission.jobId,
                consoleUrl: submission.consoleUrl,
                submittedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(trainingJobs.id, row.id))
            .returning();
        await db.insert(trainingEvents).values({
            jobId: row.id,
            kind: "submitted",
            message: `Vertex conductor job created: ${submission.jobName}`,
            data: { consoleUrl: submission.consoleUrl, jobName: submission.jobName },
            source: "vertex",
        });
        return { ok: true, job: toJobDto(updated) };
    }

    const submission = await submitAceStepLoraTrainingVertex({
        expName: row.id, // job id doubles as expName so artifacts collate
        datasetUri: cfg.datasetUri,
        outputUri: cfg.outputUri,
        maxSteps: cfg.maxSteps,
        rank: cfg.rank,
        spot: cfg.spot,
        jobId: row.id,
        appUrl: process.env.MMO_APP_URL,
        machineType: cfg.machineType,
        acceleratorType: cfg.acceleratorType,
        acceleratorCount: cfg.acceleratorCount,
        learningRate: cfg.learningRate,
        batchSize: cfg.batchSize,
    });

    if (!submission.ok) {
        await db
            .update(trainingJobs)
            .set({ status: "failed", error: submission.error, updatedAt: new Date() })
            .where(eq(trainingJobs.id, row.id));
        await db.insert(trainingEvents).values({
            jobId: row.id,
            kind: "error",
            message: `Vertex submit failed: ${submission.error}`,
            data: {},
            source: "vertex",
        });
        return { ok: false, error: submission.error };
    }

    const [updated] = await db
        .update(trainingJobs)
        .set({
            status: "submitted",
            externalJobName: submission.jobName,
            externalJobId: submission.jobId,
            consoleUrl: submission.consoleUrl,
            submittedAt: new Date(),
            updatedAt: new Date(),
        })
        .where(eq(trainingJobs.id, row.id))
        .returning();
    await db.insert(trainingEvents).values({
        jobId: row.id,
        kind: "submitted",
        message: `Vertex job created: ${submission.jobName}`,
        data: { consoleUrl: submission.consoleUrl, jobName: submission.jobName },
        source: "vertex",
    });

    return { ok: true, job: toJobDto(updated) };
}

// ─── Reads ──────────────────────────────────────────────────────────────

export async function listTrainingJobs(opts?: {
    status?: TrainingStatus;
    kind?: TrainingJobKind;
    limit?: number;
}): Promise<TrainingJobDto[]> {
    const userId = await uid();
    const conds = [eq(trainingJobs.userId, userId)];
    if (opts?.status) conds.push(eq(trainingJobs.status, opts.status));
    if (opts?.kind) conds.push(eq(trainingJobs.kind, opts.kind));
    const rows = await db
        .select()
        .from(trainingJobs)
        .where(and(...conds))
        .orderBy(desc(trainingJobs.createdAt))
        .limit(opts?.limit ?? 50);
    return rows.map(toJobDto);
}

export async function getTrainingJob(jobId: string): Promise<TrainingJobDto | null> {
    const userId = await uid();
    const [row] = await db
        .select()
        .from(trainingJobs)
        .where(and(eq(trainingJobs.id, jobId), eq(trainingJobs.userId, userId)))
        .limit(1);
    return row ? toJobDto(row) : null;
}

export interface TrainingEventDto {
    id: string;
    jobId: string;
    kind: string;
    step: number | null;
    message: string | null;
    data: Record<string, unknown>;
    source: string;
    createdAt: string;
}

export async function listTrainingEvents(
    jobId: string,
    opts?: { sinceId?: string; limit?: number; kinds?: string[] },
): Promise<TrainingEventDto[]> {
    const userId = await uid();
    // Authz check
    const [job] = await db
        .select({ id: trainingJobs.id })
        .from(trainingJobs)
        .where(and(eq(trainingJobs.id, jobId), eq(trainingJobs.userId, userId)))
        .limit(1);
    if (!job) return [];
    const conds = [eq(trainingEvents.jobId, jobId)];
    if (opts?.sinceId) {
        // Lexicographic UUID ordering isn't safe, so use created_at via subquery.
        const [since] = await db
            .select({ createdAt: trainingEvents.createdAt })
            .from(trainingEvents)
            .where(eq(trainingEvents.id, opts.sinceId))
            .limit(1);
        if (since?.createdAt) {
            conds.push(gt(trainingEvents.createdAt, since.createdAt));
        }
    }
    const rows = await db
        .select()
        .from(trainingEvents)
        .where(and(...conds))
        .orderBy(trainingEvents.createdAt)
        .limit(opts?.limit ?? 200);
    return rows
        .filter((r) => !opts?.kinds || opts.kinds.includes(r.kind))
        .map((r) => ({
            id: r.id,
            jobId: r.jobId,
            kind: r.kind,
            step: r.step,
            message: r.message,
            data: (r.data ?? {}) as Record<string, unknown>,
            source: r.source,
            createdAt: (r.createdAt ?? new Date()).toISOString(),
        }));
}

// ─── Control signal ─────────────────────────────────────────────────────

const ControlPatchSchema = z.object({
    learningRate: z.number().positive().nullable().optional(),
    datasetItemWeights: z.record(z.string(), z.number().min(0).max(10)).nullable().optional(),
    earlyStop: z.boolean().nullable().optional(),
    evalPrompt: z.string().max(500).nullable().optional(),
    evalNow: z.boolean().nullable().optional(),
    pause: z.boolean().nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    updatedBy: z.enum(["maestro", "user", "system"]).optional(),
});

export type ControlPatch = z.infer<typeof ControlPatchSchema>;

export async function patchControlSignal(
    jobId: string,
    patch: ControlPatch,
): Promise<{ ok: true; controlSignal: ControlSignal } | { ok: false; error: string }> {
    const userId = await uid();
    const parsed = ControlPatchSchema.safeParse(patch);
    if (!parsed.success) return { ok: false, error: `invalid-patch: ${parsed.error.message}` };
    const [job] = await db
        .select()
        .from(trainingJobs)
        .where(and(eq(trainingJobs.id, jobId), eq(trainingJobs.userId, userId)))
        .limit(1);
    if (!job) return { ok: false, error: "job-not-found" };
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return { ok: false, error: `job-already-${job.status}` };
    }
    const next: ControlSignal = {
        ...(job.controlSignal as ControlSignal),
        ...parsed.data,
        updatedAt: new Date().toISOString(),
        updatedBy: parsed.data.updatedBy ?? "user",
    };
    await db
        .update(trainingJobs)
        .set({ controlSignal: next, updatedAt: new Date() })
        .where(eq(trainingJobs.id, jobId));
    await db.insert(trainingEvents).values({
        jobId,
        kind: "controlPatch",
        message: `Control signal patched by ${next.updatedBy}: ${describePatch(parsed.data)}`,
        data: parsed.data as Record<string, unknown>,
        source: next.updatedBy ?? "user",
    });
    await appendSync(userId, "trainingJob", jobId, "upsert", { id: jobId, controlSignal: next });
    return { ok: true, controlSignal: next };
}

function describePatch(p: ControlPatch): string {
    const parts: string[] = [];
    if (p.learningRate != null) parts.push(`lr=${p.learningRate}`);
    if (p.earlyStop) parts.push("earlyStop");
    if (p.pause != null) parts.push(p.pause ? "pause" : "resume");
    if (p.evalNow) parts.push("evalNow");
    if (p.evalPrompt) parts.push(`evalPrompt='${p.evalPrompt.slice(0, 40)}'`);
    if (p.datasetItemWeights) parts.push(`weights(${Object.keys(p.datasetItemWeights).length})`);
    if (p.note) parts.push(`note`);
    return parts.join(", ") || "noop";
}

/** Internal — called by the trainer-control API route. Returns the
 *  current signal AND clears one-shot fields so the trainer doesn't
 *  apply them twice. Auth check is by the route (HMAC, not user). */
export async function consumeControlSignalForTrainer(jobId: string): Promise<ControlSignal | null> {
    const [job] = await db
        .select()
        .from(trainingJobs)
        .where(eq(trainingJobs.id, jobId))
        .limit(1);
    if (!job) return null;
    const sig = (job.controlSignal ?? {}) as ControlSignal;
    // Clear evalNow (one-shot) so the trainer doesn't render again next tick.
    if (sig.evalNow) {
        const cleared: ControlSignal = { ...sig, evalNow: false };
        await db
            .update(trainingJobs)
            .set({ controlSignal: cleared, updatedAt: new Date() })
            .where(eq(trainingJobs.id, jobId));
        return cleared;
    }
    return sig;
}

// ─── Cancel ─────────────────────────────────────────────────────────────

export async function cancelTrainingJob(jobId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const userId = await uid();
    const [job] = await db
        .select()
        .from(trainingJobs)
        .where(and(eq(trainingJobs.id, jobId), eq(trainingJobs.userId, userId)))
        .limit(1);
    if (!job) return { ok: false, error: "job-not-found" };
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return { ok: false, error: `job-already-${job.status}` };
    }

    // Try to cancel on the provider side. For Vertex this is best-effort —
    // a Cloud Run script `infra/vertex/cancel-job.py` mirrors the submit
    // pattern. Failure to cancel is non-fatal; we still mark our row.
    if (job.provider === "vertex" && job.externalJobName) {
        try {
            await cancelVertexJob(job.externalJobName);
        } catch (err) {
            await db.insert(trainingEvents).values({
                jobId,
                kind: "warning",
                message: `Vertex cancel failed: ${err instanceof Error ? err.message : String(err)}`,
                source: "vertex",
                data: {},
            });
        }
    }
    await db
        .update(trainingJobs)
        .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(trainingJobs.id, jobId));
    await db.insert(trainingEvents).values({
        jobId,
        kind: "cancelled",
        message: "Cancelled by user",
        source: "user",
        data: {},
    });
    await appendSync(userId, "trainingJob", jobId, "upsert", { id: jobId, status: "cancelled" });
    return { ok: true };
}

async function cancelVertexJob(jobName: string): Promise<void> {
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const fsp = await import("node:fs/promises");
    const workspaceRoot = path.resolve(process.cwd(), "..");
    const script = path.join(workspaceRoot, "infra", "vertex", "cancel-job.py");
    try {
        await fsp.access(script);
    } catch {
        // Optional script — skip silently if not present yet.
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const child = spawn("python", [script, "--job-name", jobName], {
            cwd: workspaceRoot,
            env: {
                ...process.env,
                GCP_PROJECT_ID: process.env.GCP_PROJECT_ID ?? "mmo-mw-prod",
                GCP_REGION: process.env.GCP_REGION ?? "europe-west1",
            },
        });
        const killer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
            reject(new Error("cancel-timeout-30s"));
        }, 30_000);
        child.on("error", (e) => { clearTimeout(killer); reject(e); });
        child.on("close", () => { clearTimeout(killer); resolve(); });
    });
}

// ─── Internal: trainer event ingestion ──────────────────────────────────

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
 *  progress fields and appends to the event log. */
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
        // Append to loss_history — capped at 500 entries to keep row small.
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

    // On successful finish, auto-register the LoRA so the inference router
    // picks it up immediately. The trainer ships `weightsUri` + `previewUri`
    // inside the data payload of the `finished` event.
    if (ev.kind === "finished" && job.kind.endsWith("-lora")) {
        const dataPayload = (ev.data ?? {}) as Record<string, unknown>;
        const weightsUri = (ev.weightsUri
            ?? dataPayload["weightsUri"]
            ?? (raw as Record<string, unknown>)["weightsUri"]) as unknown;
        const previewUri = (ev.previewUri
            ?? dataPayload["previewUri"]
            ?? (raw as Record<string, unknown>)["previewUri"]) as unknown;
        if (typeof weightsUri === "string" && weightsUri.startsWith("gs://")) {
            // Pull tagHistogram from the linked dataset so the LoRA gets
            // genre/mood tags — that's what findLorasForPrompt scores on.
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
                    baseModel: (job.config as TrainConfig).baseModel,
                    rank: (job.config as TrainConfig).rank,
                    weightsUri,
                    previewUri: typeof previewUri === "string" ? previewUri : null,
                    tags: tagsArr,
                    evalLoss: job.lastEvalLoss,
                })
                .onConflictDoNothing();
        }
    }

    return { ok: true };
}
