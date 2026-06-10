"use server";

/**
 * Voice-conversion (RVC v2) actions.
 *
 * Powers the "convert vocals with my voice" workflow:
 *   1. Take any existing audio asset (or a freshly uploaded vocal).
 *   2. Optionally run Demucs on it to isolate the vocals stem.
 *   3. Run RVC v2 to retarget the vocal timbre to the user's trained model.
 *   4. Optionally re-mix the converted vocal with the original backing.
 *   5. Persist the result as a new generated-asset row so it shows up
 *      in /library and can be dropped on a DAW track.
 *
 * Wired into Maestro via `listRvcVoiceModels` and `convertVocalWithRVC`
 * (see app/src/lib/maestro/tools.ts).
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { generatedAssets } from "@/db/schema-ai";
import {
    listRVCModels,
    convertVocalWithRVC,
    fetchEngineJobFile,
    type RVCModelMeta,
} from "@/lib/companion-voice";

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");

export async function listVoiceConversionModels(): Promise<RVCModelMeta[]> {
    await uid();
    return await listRVCModels();
}

export interface ConvertAssetInput {
    assetId: string;
    modelId: string;
    pitchSemitones?: number;
    indexRate?: number;
    f0Method?: "rmvpe" | "pm" | "harvest" | "crepe";
    /** When true, run Demucs first to isolate vocals and re-mix after. */
    isolateFirst?: boolean;
}

export type ConvertAssetResult =
    | {
          ok: true;
          newAssetId: string;
          /** Public proxy URL for the converted result. */
          url: string;
          durationSec: number;
          sampleRate: number;
          /** When isolateFirst was true, also the full re-mixed song. */
          remixUrl?: string;
      }
    | { ok: false; error: string };

export async function convertAssetWithRVC(input: ConvertAssetInput): Promise<ConvertAssetResult> {
    const userId = await uid();

    // 1. Resolve the source asset to an absolute on-disk path. The
    // companion needs an absolute path it can read directly — we store
    // generated audio under <cwd>/data/generated/<userId>/<assetId>/.
    const [row] = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.id, input.assetId), eq(generatedAssets.userId, userId)))
        .limit(1);
    if (!row) return { ok: false, error: "asset-not-found" };
    if (!row.filePath) return { ok: false, error: "asset-not-ready" };
    const userDir = path.join(GENERATED_DIR, userId);
    const absInput = path.resolve(userDir, row.filePath);
    // Defense-in-depth: the DB row should always be inside userDir, but if it
    // ever isn't (corrupted row, manual edit) we refuse rather than read outside.
    if (!absInput.startsWith(path.resolve(userDir) + path.sep)) {
        return { ok: false, error: "asset-path-outside-user-dir" };
    }
    try {
        await fsp.access(absInput);
    } catch {
        return { ok: false, error: "source-file-missing" };
    }

    // 2. Insert a placeholder row so the UI can show "pending" while
    // the conversion runs (RVC + optional Demucs can take up to 1 min).
    const newAssetId = randomUUID();
    await fsp.mkdir(userDir, { recursive: true });
    const assetDir = path.join(userDir, newAssetId);
    await fsp.mkdir(assetDir, { recursive: true });

    await db.insert(generatedAssets).values({
        id: newAssetId,
        userId,
        kind: "stem",
        tier: "T0",
        model: `companion:rvc:${input.modelId}`,
        promptText: `RVC convert of ${row.id} → ${input.modelId}`,
        params: {
            source: row.id,
            modelId: input.modelId,
            pitchSemitones: input.pitchSemitones ?? 0,
            indexRate: input.indexRate ?? 0.66,
            f0Method: input.f0Method ?? "rmvpe",
            isolateFirst: input.isolateFirst ?? true,
        },
        license: "user-trained-voice",
        status: "pending",
    });

    // 3. Fire the conversion on the companion.
    let resp: Awaited<ReturnType<typeof convertVocalWithRVC>> = null;
    try {
        resp = await convertVocalWithRVC({
            inputPath: absInput,
            modelId: input.modelId,
            pitchSemitones: input.pitchSemitones ?? 0,
            indexRate: input.indexRate ?? 0.66,
            f0Method: input.f0Method ?? "rmvpe",
            isolateVocalsFirst: input.isolateFirst ?? true,
        });
    } catch (e) {
        await failAsset(newAssetId, e instanceof Error ? e.message : String(e));
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!resp) {
        await failAsset(newAssetId, "companion-unavailable");
        return { ok: false, error: "companion-unavailable" };
    }

    // 4. Pull the converted vocal back from the companion job dir.
    const vocalsBuf = await fetchEngineJobFile(resp.jobId, resp.converted);
    if (!vocalsBuf) {
        await failAsset(newAssetId, "converted-file-missing");
        return { ok: false, error: "converted-file-missing" };
    }
    const vocalsFile = "vocals-rvc.wav";
    await fsp.writeFile(path.join(assetDir, vocalsFile), vocalsBuf);
    const vocalsHash = createHash("sha256").update(vocalsBuf).digest("hex");

    // 5. Optionally pull the re-mix too (when isolateFirst was true).
    let remixRel: string | undefined;
    if (resp.mix) {
        const mixBuf = await fetchEngineJobFile(resp.jobId, resp.mix);
        if (mixBuf) {
            remixRel = "remix.wav";
            await fsp.writeFile(path.join(assetDir, remixRel), mixBuf);
        }
    }

    // 6. Promote the asset row to ready.
    const filePath = `${newAssetId}/${vocalsFile}`;
    const [updated] = await db
        .update(generatedAssets)
        .set({
            filePath,
            fileSize: vocalsBuf.byteLength,
            contentHash: vocalsHash,
            durationSec: resp.durationSec,
            sampleRate: resp.sampleRate,
            params: {
                source: row.id,
                modelId: input.modelId,
                pitchSemitones: input.pitchSemitones ?? 0,
                indexRate: input.indexRate ?? 0.66,
                f0Method: input.f0Method ?? "rmvpe",
                isolateFirst: input.isolateFirst ?? true,
                jobId: resp.jobId,
                device: resp.device,
                remix: remixRel ? `${newAssetId}/${remixRel}` : undefined,
            },
            status: "ready",
            error: null,
            updatedAt: new Date(),
        })
        .where(eq(generatedAssets.id, newAssetId))
        .returning();

    return {
        ok: true,
        newAssetId: updated?.id ?? newAssetId,
        url: `/api/generated/${updated?.id ?? newAssetId}`,
        durationSec: resp.durationSec,
        sampleRate: resp.sampleRate,
        remixUrl: remixRel ? `/api/generated/${updated?.id ?? newAssetId}?stem=remix` : undefined,
    };
}

async function failAsset(assetId: string, error: string): Promise<void> {
    await db
        .update(generatedAssets)
        .set({ status: "failed", error, updatedAt: new Date() })
        .where(eq(generatedAssets.id, assetId));
}
