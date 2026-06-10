import "server-only";

/**
 * Maestro training tools.
 *
 * Returned by `buildTrainingTools(ctx)` and spread into the main tool
 * catalog in `tools.ts`. Each tool wraps a server action from
 * `actions/training.ts`, `actions/training-datasets.ts`,
 * `actions/loras.ts`, or `actions/generation-feedback.ts`.
 *
 * Authorization:
 *  - `submitTrainingJob`, `cancelTrainingJob`, `patchTrainingControl` and
 *    `materializeDataset` are destructive (long-running, cost-incurring)
 *    and therefore check `ctx.allowDestructive`.
 *  - All other tools are read-only or low-risk write (recording feedback,
 *    creating draft datasets) and run without the destructive flag.
 *
 * Style notes:
 *  - Descriptions include cost hints ("~$3 on A100 spot") so Maestro can
 *    decide intelligently against the monthly budget cap.
 *  - All tools return `{ ok: true, ...payload, message: string }` or
 *    `{ ok: false, error }` — matching the catalog convention.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./tools";
import {
    cancelTrainingJob,
    estimateJobCostUsd,
    getMonthlySpendUsd,
    getTrainingJob,
    listTrainingEvents,
    listTrainingJobs,
    patchControlSignal,
    proposeGenreTrainingPlan,
    submitTrainingJob,
    type TrainingJobKind,
} from "@/actions/training";
import { machineTypeForAccelerator } from "@/lib/training/machine-types";
import {
    archiveDataset,
    buildDatasetFromGeneratedAssets,
    buildDatasetFromLibrary,
    buildDatasetFromSamplePack,
    buildDatasetFromThumbsUp,
    getDataset,
    listDatasets,
    materializeDataset,
    setDatasetItemCaption,
    setDatasetItemWeight,
} from "@/actions/training-datasets";
import { findLorasForPrompt, listLoras, updateLora } from "@/actions/loras";
import {
    recordGenerationFeedback,
    summarizeFeedback,
    listFeedbackForAsset,
} from "@/actions/generation-feedback";

function refusedDestructive(toolName: string) {
    return {
        ok: false as const,
        reason: "destructive-disabled" as const,
        message: `${toolName} requires ai.agent.allowDestructive. Toggle it in /settings/copilot → Agent.`,
    };
}

const TRAIN_KINDS = ["style-lora", "user-lora", "conductor-sft", "conductor-dpo", "acestep-dpo", "stem-aware"] as const;

export function buildTrainingTools(ctx: ToolContext): Record<string, Tool> {
    return {
        listTrainingJobs: tool({
            description:
                "List the user's training jobs (most recent first). Use this to answer 'how is my training going', " +
                "to check whether a job is still running before submitting a new one, or to find candidates for " +
                "patchTrainingControl. Returns up to 50 jobs with id, name, kind, status, currentStep, lastLoss, " +
                "estimated/actual cost, and Vertex console URL.",
            inputSchema: z.object({
                status: z.enum(["pending", "submitted", "running", "paused", "succeeded", "failed", "cancelled"]).optional(),
                kind: z.enum(TRAIN_KINDS).optional(),
                limit: z.number().int().min(1).max(50).default(20),
            }),
            execute: async ({ status, kind, limit }) => {
                try {
                    const jobs = await listTrainingJobs({ status, kind, limit });
                    return { ok: true as const, jobs, count: jobs.length };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        getTrainingJob: tool({
            description:
                "Fetch full details for one training job by id: locked config, mutable controlSignal, current step, " +
                "loss history (last 500 entries), latest sample audio URI, latest checkpoint URI, estimated cost.",
            inputSchema: z.object({ jobId: z.string() }),
            execute: async ({ jobId }) => {
                const job = await getTrainingJob(jobId);
                return job ? { ok: true as const, job } : { ok: false as const, error: "job-not-found" };
            },
        }),

        getTrainingProgress: tool({
            description:
                "Return a compact progress summary (currentStep, lastLoss, lastEvalLoss, loss trend, recent events). " +
                "Cheaper than getTrainingJob when you just need to decide whether to nudge a control signal. " +
                "Includes the last 20 events of any kind plus the next 5 most recent step events.",
            inputSchema: z.object({ jobId: z.string() }),
            execute: async ({ jobId }) => {
                const job = await getTrainingJob(jobId);
                if (!job) return { ok: false as const, error: "job-not-found" };
                const events = await listTrainingEvents(jobId, { limit: 20 });
                // Loss trend: compare avg of last 100 steps vs avg of preceding 100.
                const hist = job.lossHistory ?? [];
                const tail = hist.slice(-100);
                const prev = hist.slice(-200, -100);
                const avg = (xs: typeof tail) => (xs.length ? xs.reduce((a, b) => a + b.loss, 0) / xs.length : null);
                const tailAvg = avg(tail);
                const prevAvg = avg(prev);
                const trend = tailAvg != null && prevAvg != null
                    ? (tailAvg < prevAvg - 0.01 ? "improving" : tailAvg > prevAvg + 0.01 ? "worsening" : "plateau")
                    : "warming-up";
                return {
                    ok: true as const,
                    status: job.status,
                    currentStep: job.currentStep,
                    maxSteps: job.config.maxSteps,
                    pctComplete: job.config.maxSteps > 0 ? Math.round((job.currentStep / job.config.maxSteps) * 100) : 0,
                    lastLoss: job.lastLoss,
                    lastEvalLoss: job.lastEvalLoss,
                    tailAvgLoss: tailAvg,
                    prevAvgLoss: prevAvg,
                    trend,
                    latestSampleUri: job.latestSampleUri,
                    controlSignal: job.controlSignal,
                    estimatedCostUsd: job.estimatedCostUsd,
                    actualCostUsd: job.actualCostUsd,
                    recentEvents: events.slice(-20).map((e) => ({
                        kind: e.kind, step: e.step, message: e.message, at: e.createdAt,
                    })),
                };
            },
        }),

        proposeGenreTrainingPlan: tool({
            description:
                "Scan the user's library and surface per-genre training opportunities. Returns the top genres " +
                "(by track count), each annotated with eligibility (>=100 tracks by default), the suggested " +
                "dataset size (capped per-genre), and an estimated training cost on L4-spot. Use this BEFORE " +
                "recommending a multi-genre training run so the user sees real numbers from their own library. " +
                "Free — read-only.",
            inputSchema: z.object({
                minTracks: z.number().int().min(20).max(2000).default(100),
                perGenreCap: z.number().int().min(50).max(2000).default(300),
                topN: z.number().int().min(1).max(30).default(10),
            }),
            execute: async ({ minTracks, perGenreCap, topN }) => {
                const res = await proposeGenreTrainingPlan({ minTracks, perGenreCap, topN });
                if (!res.ok) return { ok: false as const, error: res.error };
                const eligibleCount = res.plan.filter((p) => p.eligible).length;
                return {
                    ok: true as const,
                    plan: res.plan,
                    totalLibrary: res.totalLibrary,
                    eligibleGenres: eligibleCount,
                    message:
                        `Library has ${res.totalLibrary} tracks across ${res.plan.length} genres. ` +
                        `${eligibleCount} qualify for training (>=${minTracks} tracks). ` +
                        `Per-genre LoRA cost on L4-spot ≈ $${res.plan[0]?.estCostUsd ?? 0}. ` +
                        `For each eligible genre call buildDatasetFromLibrary({genre, limit, name:'library-<genre>'}) → ` +
                        `materializeDataset → submitTrainingJob({kind:'style-lora', name:'<genre>-lora'}).`,
                };
            },
        }),

        proposeTrainingJob: tool({
            description:
                "Dry-run a training job submission: compute the estimated cost + wall-time, surface the merged " +
                "config (kind defaults + user overrides), and report current monthly spend against the cap. Use " +
                "this BEFORE submitTrainingJob to confirm cost with the user. Does NOT consume budget.",
            inputSchema: z.object({
                kind: z.enum(TRAIN_KINDS),
                acceleratorType: z.enum(["NVIDIA_A100_80GB", "NVIDIA_A100_40GB", "NVIDIA_L4", "NVIDIA_TESLA_T4"]).optional(),
                maxSteps: z.number().int().min(100).max(50000).optional(),
                rank: z.number().int().min(4).max(128).optional(),
                spot: z.boolean().optional(),
            }),
            execute: async ({ kind, acceleratorType, maxSteps, rank, spot }) => {
                // Cheap clone of KIND_DEFAULTS — we re-import to avoid coupling.
                const defaults: Record<string, { acc: string; steps: number; rank: number; spot: boolean }> = {
                    "style-lora": { acc: "NVIDIA_A100_40GB", steps: 5000, rank: 32, spot: true },
                    "user-lora": { acc: "NVIDIA_L4", steps: 2000, rank: 16, spot: true },
                    "conductor-sft": { acc: "NVIDIA_A100_40GB", steps: 3000, rank: 16, spot: true },
                    "conductor-dpo": { acc: "NVIDIA_A100_40GB", steps: 1500, rank: 16, spot: true },
                    "acestep-dpo": { acc: "NVIDIA_A100_40GB", steps: 2000, rank: 32, spot: true },
                    "stem-aware": { acc: "NVIDIA_A100_40GB", steps: 4000, rank: 32, spot: true },
                };
                const d = defaults[kind];
                const acc = acceleratorType ?? d.acc;
                const merged = {
                    baseModel: "ACE-Step/ACE-Step-v1-3.5B",
                    machineType: machineTypeForAccelerator(acc),
                    acceleratorType: acc,
                    acceleratorCount: 1,
                    spot: spot ?? d.spot,
                    datasetUri: "(none — supply at submit)",
                    outputUri: "(none — supply at submit)",
                    maxSteps: maxSteps ?? d.steps,
                    rank: rank ?? d.rank,
                    learningRate: 1e-4,
                    batchSize: 1,
                    warmupSteps: 100,
                    evalEverySteps: 200,
                    checkpointEverySteps: 500,
                    evalPrompt: "(default per-kind)",
                    seed: 42,
                };
                const est = await estimateJobCostUsd(merged);
                const spent = await getMonthlySpendUsd(ctx.userId);
                const cap = Number.parseFloat(process.env.MMO_TRAINING_BUDGET_USD ?? "500");
                const wouldExceed = spent + est.usd > cap;
                return {
                    ok: true as const,
                    config: merged,
                    estimate: {
                        hours: Math.round(est.hours * 10) / 10,
                        costUsd: Math.round(est.usd * 100) / 100,
                    },
                    budget: {
                        monthlyCapUsd: cap,
                        spentUsd: Math.round(spent * 100) / 100,
                        remainingUsd: Math.round((cap - spent) * 100) / 100,
                        wouldExceedAfterThisJob: wouldExceed,
                    },
                    nextStep: wouldExceed
                        ? "Refuse politely and explain that the monthly cap would be exceeded."
                        : "Call submitTrainingJob with the same parameters plus datasetId or datasetUri+outputUri.",
                };
            },
        }),

        submitTrainingJob: tool({
            description:
                "Submit a Vertex AI training job. DESTRUCTIVE: incurs cloud spend (typically $0.5–$15 on spot " +
                "A100/L4). Always call proposeTrainingJob first to show the user the estimate. Requires either a " +
                "datasetId (preferred — built via buildDatasetFromThumbsUp/Library/SamplePack + materializeDataset) " +
                "or raw gs:// URIs. Returns the persisted job row plus a Vertex console URL.",
            inputSchema: z.object({
                kind: z.enum(TRAIN_KINDS),
                name: z.string().min(1).max(120),
                description: z.string().max(1000).optional(),
                datasetId: z.string().optional(),
                datasetUri: z.string().startsWith("gs://").optional(),
                outputUri: z.string().startsWith("gs://").optional(),
                acceleratorType: z.enum(["NVIDIA_A100_80GB", "NVIDIA_A100_40GB", "NVIDIA_L4", "NVIDIA_TESLA_T4"]).optional(),
                machineType: z.string().optional(),
                maxSteps: z.number().int().min(100).max(50000).optional(),
                rank: z.number().int().min(4).max(128).optional(),
                spot: z.boolean().optional(),
                evalPrompt: z.string().max(500).optional(),
            }),
            execute: async (input) => {
                if (!ctx.allowDestructive) return refusedDestructive("submitTrainingJob");
                const res = await submitTrainingJob({
                    kind: input.kind,
                    name: input.name,
                    description: input.description,
                    datasetId: input.datasetId,
                    datasetUri: input.datasetUri,
                    outputUri: input.outputUri,
                    config: {
                        acceleratorType: input.acceleratorType,
                        machineType: input.machineType,
                        maxSteps: input.maxSteps,
                        rank: input.rank,
                        spot: input.spot,
                        evalPrompt: input.evalPrompt,
                    },
                    createdBy: "maestro",
                });
                if (!res.ok) {
                    return {
                        ok: false as const,
                        error: res.error,
                        spentUsd: res.spentUsd,
                        estimateUsd: res.estimateUsd,
                    };
                }
                return {
                    ok: true as const,
                    job: res.job,
                    message: `Submitted '${res.job.name}' (${res.job.kind}). Vertex job: ${res.job.externalJobName}. Monitor at ${res.job.consoleUrl}.`,
                };
            },
        }),

        patchTrainingControl: tool({
            description:
                "Apply a live control patch to a running training job: lower the learning rate, request an eval " +
                "sample right now, pause/resume, request early-stop, set a new eval prompt, or boost/dampen " +
                "specific dataset items. The trainer polls /api/training/control every 50 steps and applies the " +
                "patch on its next iteration. Recorded as a `controlPatch` event so the UI shows the change. " +
                "Destructive (mid-run change to a paid job).",
            inputSchema: z.object({
                jobId: z.string(),
                learningRate: z.number().positive().nullable().optional(),
                earlyStop: z.boolean().nullable().optional(),
                pause: z.boolean().nullable().optional(),
                evalNow: z.boolean().nullable().optional(),
                evalPrompt: z.string().max(500).nullable().optional(),
                datasetItemWeights: z.record(z.string(), z.number().min(0).max(10)).nullable().optional(),
                note: z.string().max(500).nullable().optional(),
            }),
            execute: async ({ jobId, ...patch }) => {
                if (!ctx.allowDestructive) return refusedDestructive("patchTrainingControl");
                const res = await patchControlSignal(jobId, { ...patch, updatedBy: "maestro" });
                if (!res.ok) return { ok: false as const, error: res.error };
                return {
                    ok: true as const,
                    controlSignal: res.controlSignal,
                    message: `Control patched. Trainer will apply on next poll (~50 steps).`,
                };
            },
        }),

        cancelTrainingJob: tool({
            description:
                "Stop a running training job. Issues a cancel request to Vertex AI (best-effort) and marks the " +
                "job as cancelled locally. Destructive — partial work is lost (latest checkpoint is preserved on " +
                "GCS but no further steps run).",
            inputSchema: z.object({ jobId: z.string() }),
            execute: async ({ jobId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("cancelTrainingJob");
                const res = await cancelTrainingJob(jobId);
                if (!res.ok) return { ok: false as const, error: res.error };
                return { ok: true as const, message: "Job cancelled." };
            },
        }),

        // ── Datasets ─────────────────────────────────────────────────

        listTrainingDatasets: tool({
            description:
                "List the user's training datasets plus any shared public datasets. Each row includes id, name, " +
                "sourceKind (user-library | thumbs-up | shipped-loops | uploaded-refs | fma | mtg-jamendo), " +
                "itemCount, totalDurationSec, tagHistogram, gcsUri (if materialized), status.",
            inputSchema: z.object({}),
            execute: async () => {
                const datasets = await listDatasets();
                return { ok: true as const, datasets, count: datasets.length };
            },
        }),

        buildDatasetFromThumbsUp: tool({
            description:
                "Build a 'tastebox' dataset from every generated asset the user has thumbed up. Returns the new " +
                "dataset row in 'draft' status. Call materializeDataset afterward to upload to GCS, then " +
                "submitTrainingJob (typically kind='user-lora'). Free — only DB writes.",
            inputSchema: z.object({
                name: z.string().min(1).max(120).default("My taste"),
                description: z.string().max(1000).optional(),
                minScore: z.number().int().min(1).max(5).default(1),
            }),
            execute: async ({ name, description, minScore }) => {
                const res = await buildDatasetFromThumbsUp({ name, description, minScore });
                if (!res.ok) return { ok: false as const, error: res.error };
                return {
                    ok: true as const,
                    dataset: res.dataset,
                    included: res.included,
                    message: `Built '${name}' with ${res.included} thumbs-up items. Next: materializeDataset, then submitTrainingJob(kind='user-lora').`,
                };
            },
        }),

        buildDatasetFromLibrary: tool({
            description:
                "Bundle real tracks from the user's music library (the `tracks` table — songs added/scanned by the " +
                "companion) into a training dataset. Optional filters: genre, BPM range, Camelot key, limit. " +
                "If the library is empty in the current environment, gracefully falls back to the user's ready " +
                "generated assets so the pipeline always has audio. Captions are auto-built from track metadata " +
                "(title, artist, genre, BPM, key, mood). Returns dataset in 'draft' — next call materializeDataset " +
                "then submitTrainingJob(kind='style-lora'|'user-lora'). Free — only DB writes.",
            inputSchema: z.object({
                name: z.string().min(1).max(120).default("My library"),
                description: z.string().max(1000).optional(),
                genre: z.string().min(1).max(60).optional(),
                minBpm: z.number().min(40).max(220).optional(),
                maxBpm: z.number().min(40).max(220).optional(),
                keyCamelot: z.string().min(1).max(4).optional(),
                limit: z.number().int().min(1).max(500).default(200),
                fallbackToGenerated: z.boolean().default(true),
            }),
            execute: async (input) => {
                const res = await buildDatasetFromLibrary(input);
                if (!res.ok) return { ok: false as const, error: res.error };
                return {
                    ok: true as const,
                    dataset: res.dataset,
                    included: res.included,
                    source: res.source,
                    message:
                        `Built '${input.name}' with ${res.included} items from ` +
                        `${res.source === "tracks" ? "library tracks" : "generated assets (library empty)"}. ` +
                        `Next: materializeDataset, then submitTrainingJob(kind='style-lora').`,
                };
            },
        }),

        buildDatasetFromAssets: tool({
            description:
                "Bundle a hand-picked set of generated assetIds into a training dataset. Captions default to the " +
                "asset's original prompt text. Use this when the user has explicit assetIds from listGeneratedAssets. " +
                "For 'train on my library' prefer buildDatasetFromLibrary. Free.",
            inputSchema: z.object({
                name: z.string().min(1).max(120),
                description: z.string().max(1000).optional(),
                assetIds: z.array(z.string()).min(1).max(2000),
                captionMode: z.enum(["promptText", "auto", "manual"]).default("promptText"),
            }),
            execute: async (input) => {
                const res = await buildDatasetFromGeneratedAssets(input);
                if (!res.ok) return { ok: false as const, error: res.error };
                return {
                    ok: true as const,
                    dataset: res.dataset,
                    message: `Built '${input.name}' with ${res.dataset.itemCount} items. Next: materializeDataset, then submitTrainingJob.`,
                };
            },
        }),

        buildDatasetFromSamplePack: tool({
            description:
                "Build a dataset from one of the shipped sample-pack folders (under public/samples/). packPath is " +
                "relative to public/samples/ — e.g. 'tech-house' or 'drums/kicks'. Captions are derived from the " +
                "manifest (genre + bpm + key + type). Useful as a style-LoRA seed when the user has few thumbs-up.",
            inputSchema: z.object({
                name: z.string().min(1).max(120),
                description: z.string().max(1000).optional(),
                packPath: z.string().min(1).max(500),
            }),
            execute: async (input) => {
                const res = await buildDatasetFromSamplePack(input);
                if (!res.ok) return { ok: false as const, error: res.error };
                return {
                    ok: true as const,
                    dataset: res.dataset,
                    included: res.included,
                    message: `Built '${input.name}' from sample pack '${input.packPath}' with ${res.included} samples.`,
                };
            },
        }),

        materializeDataset: tool({
            description:
                "Upload a draft dataset to GCS so a trainer can read it. Required after build* before submit*. " +
                "Egress-only cost (~$0.12/GB). Idempotent — no-op if already materialized.",
            inputSchema: z.object({ datasetId: z.string() }),
            execute: async ({ datasetId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("materializeDataset");
                const res = await materializeDataset(datasetId);
                if (!res.ok) return { ok: false as const, error: res.error };
                return {
                    ok: true as const,
                    gcsUri: res.gcsUri,
                    message: `Materialized to ${res.gcsUri}. Now call submitTrainingJob with datasetId='${datasetId}'.`,
                };
            },
        }),

        setDatasetItemCaption: tool({
            description:
                "Override the caption of one dataset item. Useful when the user says 'this one should be tagged as " +
                "amapiano not afro-house'. Takes effect on next training run (not currently-running jobs).",
            inputSchema: z.object({
                datasetId: z.string(),
                itemId: z.string(),
                caption: z.string().min(1).max(2000),
            }),
            execute: async ({ datasetId, itemId, caption }) => {
                const res = await setDatasetItemCaption(datasetId, itemId, caption);
                return res.ok ? { ok: true as const, message: "Caption updated." } : res;
            },
        }),

        setDatasetItemWeight: tool({
            description:
                "Boost (>1) or dampen (<1) a specific dataset item's sampling weight. Clamped to [0,10]. Set to 0 " +
                "to effectively exclude. Maestro can use this mid-training via patchTrainingControl's " +
                "datasetItemWeights to teach the model 'more of this, less of that' on the fly.",
            inputSchema: z.object({
                datasetId: z.string(),
                itemId: z.string(),
                weight: z.number().min(0).max(10),
            }),
            execute: async ({ datasetId, itemId, weight }) => {
                const res = await setDatasetItemWeight(datasetId, itemId, weight);
                return res.ok ? { ok: true as const, weight, message: "Weight updated." } : res;
            },
        }),

        archiveDataset: tool({
            description: "Soft-delete a dataset (status='archived'). Does NOT delete GCS files.",
            inputSchema: z.object({ datasetId: z.string() }),
            execute: async ({ datasetId }) => {
                const res = await archiveDataset(datasetId);
                return res.ok ? { ok: true as const, message: "Archived." } : res;
            },
        }),

        // ── LoRAs ─────────────────────────────────────────────────────

        listLoras: tool({
            description:
                "List LoRA adapters available to the user: their own personal LoRAs plus shared style LoRAs. " +
                "Each row has id, name, kind (style/user/stem/mood), triggerToken, baseModel, rank, " +
                "previewUri, evalLoss, thumbsUpRate, usageCount. Use this to pick adapters for generation.",
            inputSchema: z.object({
                kind: z.enum(["style", "user", "stem", "mood"]).optional(),
                status: z.enum(["active", "deprecated", "archived"]).default("active"),
            }),
            execute: async ({ kind, status }) => {
                const loras = await listLoras({ kind, status });
                return { ok: true as const, loras, count: loras.length };
            },
        }),

        updateLora: tool({
            description:
                "Rename, retag, set trigger token, or change status of a LoRA adapter. Use when the user says " +
                "'call this one Berlin Dub' or 'archive my failed afro-house experiment'.",
            inputSchema: z.object({
                id: z.string(),
                name: z.string().min(1).max(120).optional(),
                description: z.string().max(1000).nullable().optional(),
                triggerToken: z.string().max(60).nullable().optional(),
                tags: z.array(z.string().max(40)).max(20).optional(),
                status: z.enum(["active", "deprecated", "archived"]).optional(),
            }),
            execute: async (input) => {
                const res = await updateLora(input);
                if (!res.ok) return { ok: false as const, error: res.error };
                return { ok: true as const, lora: res.lora, message: "LoRA updated." };
            },
        }),

        recommendLorasForPrompt: tool({
            description:
                "Given a free-form genre/mood prompt, return the top up-to-4 LoRA adapters that match. Used " +
                "internally by the inference router to auto-attach style adapters; Maestro can call this " +
                "directly to explain to the user which LoRAs will be active for their next generation.",
            inputSchema: z.object({
                prompt: z.string().min(1).max(500),
                limit: z.number().int().min(1).max(4).default(4),
            }),
            execute: async ({ prompt, limit }) => {
                const loras = await findLorasForPrompt(prompt, limit);
                return { ok: true as const, loras, message: `${loras.length} LoRA(s) match.` };
            },
        }),

        // ── Feedback ─────────────────────────────────────────────────

        recordGenerationFeedback: tool({
            description:
                "Record the user's thumbs-up/down/flag on a generated asset, with optional structured reasons. " +
                "Feedback drives auto-built tastebox datasets, DPO preference pairs, and LoRA thumbs-up rate. " +
                "Reasons must be one of: wrong-genre, wrong-bpm, wrong-key, off-key, noisy, mushy-vocals, " +
                "robotic-vocals, too-quiet, too-loud, missing-drop, missing-bass, missing-vocals, boring, " +
                "amazing, perfect-vibe, use-as-reference, off-tempo.",
            inputSchema: z.object({
                assetId: z.string(),
                verdict: z.enum(["up", "down", "flag"]),
                reasons: z.array(z.string()).max(8).optional(),
                note: z.string().max(2000).optional(),
                score: z.number().int().min(1).max(5).optional(),
            }),
            execute: async (input) => {
                const res = await recordGenerationFeedback({
                    assetId: input.assetId,
                    verdict: input.verdict,
                    reasons: input.reasons as never,
                    note: input.note,
                    score: input.score,
                });
                if (!res.ok) return { ok: false as const, error: res.error };
                return {
                    ok: true as const,
                    created: res.created,
                    message: `Feedback recorded (${input.verdict}). Will be used in next training cycle.`,
                };
            },
        }),

        listFeedbackForAsset: tool({
            description: "Get the existing feedback row for one generated asset (if any).",
            inputSchema: z.object({ assetId: z.string() }),
            execute: async ({ assetId }) => {
                const entries = await listFeedbackForAsset(assetId);
                return { ok: true as const, entries };
            },
        }),

        summarizeFeedback: tool({
            description:
                "Aggregate the user's feedback over the last N days (default 30): totals, top complaint reasons, " +
                "recent free-form notes. Maestro should call this when the user asks 'what do you know about my " +
                "taste?' or before submitting a new style-lora to pick a good evalPrompt.",
            inputSchema: z.object({ sinceDays: z.number().int().min(1).max(365).default(30) }),
            execute: async ({ sinceDays }) => {
                const summary = await summarizeFeedback({ sinceDays });
                return { ok: true as const, summary };
            },
        }),
    };
}
