"use server";

/**
 * Vertex AI training-dataset uploader.
 *
 * Takes a set of user-owned `generatedAssets` (songs, vocals, etc.),
 * each with a prompt text, and uploads them to the GCS training bucket
 * in the layout expected by the ACE-Step LoRA trainer:
 *
 *     gs://<bucket>/<jobId>/dataset/<n>/audio.wav
 *     gs://<bucket>/<jobId>/dataset/<n>/text.txt
 *
 * After upload, the returned `{ datasetUri, outputUri }` plug straight
 * into `submitAceStepLoraTrainingVertex` (or the `trainAceStepLora`
 * Maestro tool with `target: "vertex"`).
 *
 * Auth: re-uses the credential resolution from `@/lib/gcs` — either
 * `GCP_SERVICE_ACCOUNT_KEY` (base64 JSON) or local ADC.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { Storage } from "@google-cloud/storage";

import { auth } from "@/auth";
import { db } from "@/db";
import { generatedAssets } from "@/db/schema-ai";

const TRAINING_BUCKET = process.env.GCS_TRAINING_BUCKET ?? "mmo-training-prod";
const GENERATED_DIR = path.join(process.cwd(), "data", "generated");

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

let _storage: Storage | null = null;
function getStorage(): Storage {
    if (_storage) return _storage;
    const b64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (b64 && b64.length > 100) {
        const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { project_id?: string };
        _storage = new Storage({ credentials: json as Record<string, unknown>, projectId: json.project_id });
    } else {
        _storage = new Storage();
    }
    return _storage;
}

export interface PrepareDatasetInput {
    /** Asset IDs to bundle into the training set. All must be owned by
     *  the caller, be `ready`, and have a non-empty `promptText`. */
    assetIds: string[];
    /** Optional explicit jobId; otherwise generated as `lora-<ts>`. */
    jobId?: string;
}

export type PrepareDatasetResult =
    | {
          ok: true;
          jobId: string;
          datasetUri: string;
          outputUri: string;
          fileCount: number;
          skipped: Array<{ assetId: string; reason: string }>;
      }
    | { ok: false; error: string };

/**
 * Stream-upload each asset's audio + prompt text to GCS.
 *
 * Concurrency cap: 4 parallel uploads — enough to saturate residential
 * upload pipes (~50 Mbps) without spawning hundreds of TCP sessions.
 */
export async function prepareAceStepDataset(input: PrepareDatasetInput): Promise<PrepareDatasetResult> {
    const userId = await uid();
    if (!Array.isArray(input.assetIds) || input.assetIds.length === 0) {
        return { ok: false, error: "no-asset-ids" };
    }
    if (input.assetIds.length > 500) {
        return { ok: false, error: "too-many-assets-max-500" };
    }

    // 1. Load all rows, scoped to caller.
    const rows = await db
        .select()
        .from(generatedAssets)
        .where(and(
            eq(generatedAssets.userId, userId),
            inArray(generatedAssets.id, input.assetIds),
        ));
    if (rows.length === 0) return { ok: false, error: "no-matching-assets" };

    const jobId = (input.jobId ?? `lora-${Date.now().toString(36)}`)
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 64);

    const userDir = path.resolve(path.join(GENERATED_DIR, userId));
    const skipped: Array<{ assetId: string; reason: string }> = [];

    // 2. Validate + queue every asset before opening uploads, so a bad
    // row aborts cleanly without partial dataset upload.
    type Job = { idx: number; absPath: string; prompt: string };
    const jobs: Job[] = [];
    let nextIdx = 0;
    for (const row of rows) {
        if (row.status !== "ready") { skipped.push({ assetId: row.id, reason: `status=${row.status}` }); continue; }
        if (!row.filePath) { skipped.push({ assetId: row.id, reason: "no-file-path" }); continue; }
        if (!row.promptText || !row.promptText.trim()) {
            skipped.push({ assetId: row.id, reason: "no-prompt-text" }); continue;
        }
        const abs = path.resolve(userDir, row.filePath);
        if (!abs.startsWith(userDir + path.sep)) {
            skipped.push({ assetId: row.id, reason: "path-outside-user-dir" }); continue;
        }
        try {
            await fsp.access(abs);
        } catch {
            skipped.push({ assetId: row.id, reason: "file-missing-on-disk" }); continue;
        }
        jobs.push({ idx: nextIdx++, absPath: abs, prompt: row.promptText });
    }

    if (jobs.length === 0) {
        return { ok: false, error: `no-usable-assets (skipped ${skipped.length})` };
    }

    // 3. Upload audio + text.txt for each job, capped at 4 in flight.
    const bucket = getStorage().bucket(TRAINING_BUCKET);
    const datasetPrefix = `${jobId}/dataset`;
    const concurrency = 4;
    let cursor = 0;
    const errors: string[] = [];

    async function worker() {
        while (cursor < jobs.length) {
            const j = jobs[cursor++];
            try {
                const ext = path.extname(j.absPath).toLowerCase().replace(".", "") || "wav";
                const audioKey = `${datasetPrefix}/${j.idx}/audio.${ext}`;
                const textKey = `${datasetPrefix}/${j.idx}/text.txt`;
                await bucket.upload(j.absPath, {
                    destination: audioKey,
                    metadata: { contentType: `audio/${ext}` },
                });
                await bucket.file(textKey).save(j.prompt, {
                    contentType: "text/plain; charset=utf-8",
                });
            } catch (e) {
                errors.push(`asset[${j.idx}]: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

    if (errors.length === jobs.length) {
        return { ok: false, error: `all-uploads-failed: ${errors.slice(0, 3).join("; ")}` };
    }

    const datasetUri = `gs://${TRAINING_BUCKET}/${datasetPrefix}/`;
    const outputUri = `gs://${TRAINING_BUCKET}/${jobId}/output/`;
    return {
        ok: true,
        jobId,
        datasetUri,
        outputUri,
        fileCount: jobs.length - errors.length,
        skipped: [
            ...skipped,
            ...errors.map((e, i) => ({ assetId: `upload-error-${i}`, reason: e })),
        ],
    };
}
