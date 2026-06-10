/**
 * Training platform schema (Phase 3 — Maestro autonomous trainer).
 *
 * Tables here back the /training page, the Maestro `training.*` tools, the
 * SSE event stream at /api/training/events/[jobId], and the control-signal
 * polling loop the Python trainer hits at /api/training/control/[jobId].
 *
 * Design summary (see docs/maestro-training/PLAN.md for the full plan):
 *
 *  trainingDatasets / trainingDatasetItems
 *     Curated bundles of audio + caption pairs used as input to a job.
 *     Built from the user's library + thumbs-up generations + shipped
 *     loops + optional public corpora (FMA, MTG-Jamendo). Items keep a
 *     pointer to the source asset (generated, scanned, sample) plus the
 *     LP-MusicCaps-style caption used at training time.
 *
 *  trainingJobs
 *     One row per submitted job. Mirrors Vertex AI Custom Jobs but is
 *     vendor-agnostic — `provider` distinguishes vertex/local/runpod.
 *     `controlSignal` is the mutable JSONB the trainer polls between
 *     gradient steps to receive new LR / dataset-weight / early-stop /
 *     eval-prompt commands without restarting.
 *
 *  trainingEvents
 *     Append-only. Every interesting moment in the job's life — submit,
 *     start, step, sample, checkpoint, controlSignal patch, error,
 *     finish. The SSE endpoint streams these to the UI; Maestro reads
 *     them via `getTrainingProgress`.
 *
 *  loraAssets
 *     Registry of finished LoRA adapters. Style LoRAs are shared across
 *     users (userId null OR scope='shared'); personal LoRAs are scoped
 *     to the trainer. Inference picks them by id + weight per generation.
 *
 *  generationFeedback
 *     Thumbs / structured feedback on `generated_assets` rows. Drives
 *     DPO preference pairs for the conductor + ACE-Step preference
 *     tracks.
 */

import {
    pgTable,
    text,
    timestamp,
    integer,
    real,
    jsonb,
    uniqueIndex,
    index,
    boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./schema";
import { generatedAssets } from "./schema-ai";

/** Curated dataset used as input to one or more training jobs. */
export const trainingDatasets = pgTable(
    "training_datasets",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
        // null userId + scope='shared' = public dataset everyone can train on.
        scope: text("scope").notNull().default("user"), // user | shared
        name: text("name").notNull(),
        description: text("description"),
        // user-library | thumbs-up | shipped-loops | uploaded-refs | fma | mtg-jamendo | mixed
        sourceKind: text("source_kind").notNull(),
        // Aggregate stats kept up-to-date by `recomputeDatasetStats`.
        itemCount: integer("item_count").notNull().default(0),
        totalDurationSec: real("total_duration_sec").notNull().default(0),
        // Tag histogram (genre/mood/instrument counts) — used by Maestro to
        // pick an eval prompt and to balance per-item weights at training.
        tagHistogram: jsonb("tag_histogram").$type<Record<string, number>>().default(sql`'{}'::jsonb`),
        // Optional gs:// URI of the materialized snapshot (audio.<ext> +
        // text.txt layout) the trainer reads. Null until first job submit.
        gcsUri: text("gcs_uri"),
        status: text("status").notNull().default("draft"), // draft | ready | materializing | failed | archived
        error: text("error"),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("training_datasets_user_idx").on(t.userId, t.createdAt),
        index("training_datasets_scope_idx").on(t.scope, t.status),
    ],
);

/** One row per (dataset, source asset). assetKind disambiguates the FK target. */
export const trainingDatasetItems = pgTable(
    "training_dataset_items",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        datasetId: text("dataset_id").notNull().references(() => trainingDatasets.id, { onDelete: "cascade" }),
        // generated | scanned | sample | uploaded | external
        assetKind: text("asset_kind").notNull(),
        // For assetKind='generated', points at generated_assets.id; otherwise
        // a free-form id (track id, sample relative path, upload id...).
        assetId: text("asset_id").notNull(),
        // Optional pointer back to generated_assets for cascade-aware cleanup.
        generatedAssetId: text("generated_asset_id").references(() => generatedAssets.id, { onDelete: "set null" }),
        // Caption used at training time. Auto-generated via LP-MusicCaps or
        // hand-edited; Maestro can rewrite per-item via the `tagItem` tool.
        caption: text("caption").notNull().default(""),
        // Multiplicative sampling weight. 1.0 default; Maestro can boost
        // (e.g. high-quality refs) or zero out (low-quality) at runtime via
        // controlSignal.datasetItemWeights.
        weight: real("weight").notNull().default(1),
        durationSec: real("duration_sec"),
        sampleRate: integer("sample_rate"),
        tempoBpm: real("tempo_bpm"),
        keyRoot: text("key_root"),
        keyMode: text("key_mode"),
        tags: jsonb("tags").$type<string[]>().default(sql`'[]'::jsonb`),
        // Free-form metadata: source URL, license, original prompt, etc.
        metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("training_dataset_items_dataset_idx").on(t.datasetId),
        uniqueIndex("training_dataset_items_uniq").on(t.datasetId, t.assetKind, t.assetId),
    ],
);

/**
 * One training run. The `controlSignal` JSONB is the heart of the
 * autonomous-Maestro design: the trainer polls /api/training/control
 * every N steps and applies any non-null knobs found there. Patches are
 * append-only via `patchControlSignal`, which also writes a trainingEvent
 * row so the UI can show "Maestro lowered LR to 8e-5 at step 1400".
 */
export const trainingJobs = pgTable(
    "training_jobs",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        datasetId: text("dataset_id").references(() => trainingDatasets.id, { onDelete: "set null" }),
        // style-lora | user-lora | conductor-sft | conductor-dpo | acestep-dpo | stem-aware
        kind: text("kind").notNull(),
        provider: text("provider").notNull().default("vertex"), // vertex | local | runpod
        // For vertex: 'projects/.../customJobs/<id>'. Used to cancel + poll.
        externalJobName: text("external_job_name"),
        externalJobId: text("external_job_id"),
        consoleUrl: text("console_url"),
        // Short human label; also used as Vertex display name prefix.
        name: text("name").notNull(),
        description: text("description"),

        // Locked-at-submit configuration. The trainer reads this once when
        // it starts. Anything tweakable mid-run lives in controlSignal.
        config: jsonb("config").$type<{
            baseModel: string;            // e.g. 'ACE-Step/ACE-Step-v1-3.5B'
            machineType: string;          // 'a2-highgpu-1g' | 'g2-standard-12' ...
            acceleratorType: string;      // 'NVIDIA_A100_80GB' | 'NVIDIA_L4'
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
        }>().notNull(),

        // Live mutable knobs. null means "no patch pending"; trainer
        // applies + zeros each field after consuming it.
        controlSignal: jsonb("control_signal").$type<{
            updatedAt?: string;
            updatedBy?: string; // 'maestro' | 'user' | 'system'
            learningRate?: number | null;
            datasetItemWeights?: Record<string, number> | null;
            earlyStop?: boolean | null;
            evalPrompt?: string | null;
            evalNow?: boolean | null;
            pause?: boolean | null;
            note?: string | null;
        }>().default(sql`'{}'::jsonb`),

        // Last-known progress, cached for cheap list rendering. The
        // append-only history lives in trainingEvents.
        currentStep: integer("current_step").notNull().default(0),
        lastLoss: real("last_loss"),
        lastEvalLoss: real("last_eval_loss"),
        lossHistory: jsonb("loss_history").$type<Array<{ step: number; loss: number }>>().default(sql`'[]'::jsonb`),
        latestSampleUri: text("latest_sample_uri"),
        latestCheckpointUri: text("latest_checkpoint_uri"),

        // pending | submitted | running | paused | succeeded | failed | cancelled
        status: text("status").notNull().default("pending"),
        error: text("error"),

        // Cost guardrails (enforced at submit). Maestro can read these
        // to refuse to submit a new job that would blow the budget.
        estimatedCostUsd: real("estimated_cost_usd"),
        actualCostUsd: real("actual_cost_usd"),
        maxRuntimeHours: real("max_runtime_hours").notNull().default(8),

        // Who/what created the job — Maestro vs explicit-user.
        createdBy: text("created_by").notNull().default("user"), // user | maestro | system

        submittedAt: timestamp("submitted_at", { mode: "date" }),
        startedAt: timestamp("started_at", { mode: "date" }),
        finishedAt: timestamp("finished_at", { mode: "date" }),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("training_jobs_user_idx").on(t.userId, t.createdAt),
        index("training_jobs_status_idx").on(t.status, t.updatedAt),
        index("training_jobs_kind_idx").on(t.kind),
    ],
);

/** Append-only log of everything that happens during a job. */
export const trainingEvents = pgTable(
    "training_events",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        jobId: text("job_id").notNull().references(() => trainingJobs.id, { onDelete: "cascade" }),
        // submitted | started | step | sample | checkpoint | controlPatch | warning | error | finished | cancelled
        kind: text("kind").notNull(),
        step: integer("step"),
        message: text("message"),
        // Free-form payload: { loss, evalLoss, lr, sampleUri, checkpointUri, patch, ... }
        data: jsonb("data").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
        source: text("source").notNull().default("trainer"), // trainer | maestro | user | system | vertex
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("training_events_job_idx").on(t.jobId, t.createdAt),
        index("training_events_kind_idx").on(t.jobId, t.kind),
    ],
);

/** Finished LoRA adapters available to the inference router. */
export const loraAssets = pgTable(
    "lora_assets",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
        // user | shared
        scope: text("scope").notNull().default("user"),
        // style | user | stem | mood
        kind: text("kind").notNull(),
        jobId: text("job_id").references(() => trainingJobs.id, { onDelete: "set null" }),
        name: text("name").notNull(),
        description: text("description"),
        // Trigger token the user passes in their prompt to activate this LoRA
        // (e.g. "<melodic_techno>"). Null = always-on adapter.
        triggerToken: text("trigger_token"),
        baseModel: text("base_model").notNull(), // 'ACE-Step/ACE-Step-v1-3.5B'
        rank: integer("rank").notNull(),
        // gs:// URI of the .safetensors weights.
        weightsUri: text("weights_uri").notNull(),
        // Optional preview audio rendered at training end.
        previewUri: text("preview_uri"),
        tags: jsonb("tags").$type<string[]>().default(sql`'[]'::jsonb`),
        // Mean eval loss + thumbs-up rate of generations that used this LoRA.
        evalLoss: real("eval_loss"),
        usageCount: integer("usage_count").notNull().default(0),
        thumbsUpRate: real("thumbs_up_rate"),
        // active | deprecated | archived
        status: text("status").notNull().default("active"),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("lora_assets_user_idx").on(t.userId, t.createdAt),
        index("lora_assets_scope_kind_idx").on(t.scope, t.kind, t.status),
        uniqueIndex("lora_assets_weights_uniq").on(t.weightsUri),
    ],
);

/** Per-asset structured feedback used to mine DPO preference pairs. */
export const generationFeedback = pgTable(
    "generation_feedback",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        assetId: text("asset_id").notNull().references(() => generatedAssets.id, { onDelete: "cascade" }),
        // up | down | flag
        verdict: text("verdict").notNull(),
        // Optional structured tags so the user can say *why* it was bad.
        // e.g. ['wrong-genre', 'off-key', 'mushy-vocals', 'too-quiet']
        reasons: jsonb("reasons").$type<string[]>().default(sql`'[]'::jsonb`),
        // Free-form note ("the kick is too soft", "missing the drop").
        note: text("note"),
        // Score 1..5; null when verdict is just up/down.
        score: integer("score"),
        // True when this generation has been used in a DPO pair as 'chosen'
        // or 'rejected' so we don't double-count.
        usedInDpo: boolean("used_in_dpo").notNull().default(false),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("generation_feedback_user_idx").on(t.userId, t.createdAt),
        index("generation_feedback_asset_idx").on(t.assetId),
        index("generation_feedback_verdict_idx").on(t.verdict, t.usedInDpo),
        uniqueIndex("generation_feedback_user_asset_uniq").on(t.userId, t.assetId),
    ],
);
