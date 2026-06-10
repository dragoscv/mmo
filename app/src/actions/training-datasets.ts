"use server";

/**
 * Training datasets — server actions.
 *
 * Datasets are curated bundles of (audio, caption) pairs Maestro uses
 * for training. Three flavours are supported here:
 *
 *  1. `buildFromGeneratedAssets({ assetIds })`
 *     Wrap a hand-picked list of `generated_assets` rows. Captions
 *     default to the asset's promptText.
 *
 *  2. `buildFromThumbsUp({ minScore })`
 *     Pull every `generated_assets` the caller has thumbed up.
 *     Auto-builds a "tastebox" dataset for personal-style LoRA.
 *
 *  3. `buildFromSamplePack({ pack })`
 *     Reference a shipped sample-pack directory under public/samples/.
 *     Captions come from the sample manifest (genre / oneshot / bpm).
 *
 * After a dataset is built, materialization (uploading to GCS) is done
 * lazily by `materializeDataset` — which today shells out to the existing
 * `prepareAceStepDataset` for the generated-asset case. For sample-pack
 * datasets it uploads files directly. We keep both code paths here so the
 * Maestro tools have one entry point.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/auth";
import { db } from "@/db";
import { generatedAssets } from "@/db/schema-ai";
import { trainingDatasetItems, trainingDatasets } from "@/db/schema-training";
import { generationFeedback } from "@/db/schema-training";
import { prepareAceStepDataset } from "@/actions/vertex-dataset";
import { companionLibrary, getCompanionLink, type CompanionTrack, type TrackFilters } from "@/lib/companion-library";

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

export interface DatasetDto {
    id: string;
    userId: string | null;
    scope: "user" | "shared";
    name: string;
    description: string | null;
    sourceKind: string;
    itemCount: number;
    totalDurationSec: number;
    tagHistogram: Record<string, number>;
    gcsUri: string | null;
    status: "draft" | "ready" | "materializing" | "failed" | "archived";
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

function toDto(row: typeof trainingDatasets.$inferSelect): DatasetDto {
    return {
        id: row.id,
        userId: row.userId,
        scope: row.scope as "user" | "shared",
        name: row.name,
        description: row.description,
        sourceKind: row.sourceKind,
        itemCount: row.itemCount,
        totalDurationSec: row.totalDurationSec,
        tagHistogram: (row.tagHistogram ?? {}) as Record<string, number>,
        gcsUri: row.gcsUri,
        status: row.status as DatasetDto["status"],
        error: row.error,
        createdAt: (row.createdAt ?? new Date()).toISOString(),
        updatedAt: (row.updatedAt ?? new Date()).toISOString(),
    };
}

// ─── List ───────────────────────────────────────────────────────────────

export async function listDatasets(): Promise<DatasetDto[]> {
    const userId = await uid();
    const rows = await db
        .select()
        .from(trainingDatasets)
        .where(sql`${trainingDatasets.userId} = ${userId} OR ${trainingDatasets.scope} = 'shared'`)
        .orderBy(trainingDatasets.createdAt);
    return rows.map(toDto);
}

export async function getDataset(datasetId: string): Promise<{ dataset: DatasetDto; items: number } | null> {
    const userId = await uid();
    const [row] = await db
        .select()
        .from(trainingDatasets)
        .where(
            sql`${trainingDatasets.id} = ${datasetId} AND (${trainingDatasets.userId} = ${userId} OR ${trainingDatasets.scope} = 'shared')`,
        )
        .limit(1);
    if (!row) return null;
    return { dataset: toDto(row), items: row.itemCount };
}

// ─── Build flavours ─────────────────────────────────────────────────────

const BuildFromAssetsSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    assetIds: z.array(z.string()).min(1).max(2000),
    captionMode: z.enum(["promptText", "auto", "manual"]).default("promptText"),
});

export async function buildDatasetFromGeneratedAssets(
    raw: z.infer<typeof BuildFromAssetsSchema>,
): Promise<{ ok: true; dataset: DatasetDto } | { ok: false; error: string }> {
    const userId = await uid();
    const parsed = BuildFromAssetsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid-input: ${parsed.error.message}` };
    const input = parsed.data;

    const assets = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.userId, userId), inArray(generatedAssets.id, input.assetIds)));
    const ready = assets.filter((a) => a.status === "ready" && a.filePath);
    if (ready.length === 0) return { ok: false, error: "no-ready-assets" };

    const [ds] = await db
        .insert(trainingDatasets)
        .values({
            userId,
            scope: "user",
            name: input.name,
            description: input.description ?? null,
            sourceKind: "user-library",
            itemCount: ready.length,
            totalDurationSec: ready.reduce((acc, a) => acc + (a.durationSec ?? 0), 0),
            tagHistogram: deriveTagHistogram(ready),
            status: "draft",
        })
        .returning();

    await db.insert(trainingDatasetItems).values(
        ready.map((a) => ({
            datasetId: ds.id,
            assetKind: "generated",
            assetId: a.id,
            generatedAssetId: a.id,
            caption: input.captionMode === "promptText" ? (a.promptText ?? "") : "",
            durationSec: a.durationSec ?? null,
            sampleRate: a.sampleRate ?? null,
            metadata: { sourcePrompt: a.promptText, kind: a.kind, model: a.model } as Record<string, unknown>,
        })),
    );
    return { ok: true, dataset: toDto(ds) };
}

const BuildFromThumbsSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    minScore: z.number().int().min(1).max(5).default(1),
});

export async function buildDatasetFromThumbsUp(
    raw: z.infer<typeof BuildFromThumbsSchema>,
): Promise<{ ok: true; dataset: DatasetDto; included: number } | { ok: false; error: string }> {
    const userId = await uid();
    const parsed = BuildFromThumbsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid-input: ${parsed.error.message}` };
    const input = parsed.data;

    const rows = await db
        .select({ assetId: generationFeedback.assetId })
        .from(generationFeedback)
        .where(
            and(
                eq(generationFeedback.userId, userId),
                eq(generationFeedback.verdict, "up"),
                sql`COALESCE(${generationFeedback.score}, 1) >= ${input.minScore}`,
            ),
        );
    const ids = rows.map((r) => r.assetId);
    if (ids.length === 0) return { ok: false, error: "no-thumbs-up-yet" };
    const res = await buildDatasetFromGeneratedAssets({
        name: input.name,
        description: input.description ?? `Auto-built from ${ids.length} thumbs-up generations`,
        assetIds: ids,
        captionMode: "promptText",
    });
    if (!res.ok) return res;
    // Re-stamp source_kind so the UI shows the correct provenance.
    await db
        .update(trainingDatasets)
        .set({ sourceKind: "thumbs-up", updatedAt: new Date() })
        .where(eq(trainingDatasets.id, res.dataset.id));
    return { ok: true, dataset: { ...res.dataset, sourceKind: "thumbs-up" }, included: ids.length };
}

// ─── Build from library (real tracks + on-disk generated audio) ─────────

const BuildFromLibrarySchema = z.object({
    name: z.string().min(1).max(120).default("My library"),
    description: z.string().max(1000).optional(),
    /** Optional filters on the `tracks` table. */
    genre: z.string().min(1).max(60).optional(),
    minBpm: z.number().min(40).max(220).optional(),
    maxBpm: z.number().min(40).max(220).optional(),
    keyCamelot: z.string().min(1).max(4).optional(),
    /** Cap total items. Trainers usually want 20–200 strong examples. */
    limit: z.number().int().min(1).max(500).default(200),
    /** When the `tracks` table has nothing matching, fall back to the
     *  user's ready generated assets so the pipeline still has audio. */
    fallbackToGenerated: z.boolean().default(true),
});

function captionFromTrack(t: CompanionTrack): string {
    const parts: string[] = [];
    if (t.title) parts.push(t.title);
    if (t.artist) parts.push(`by ${t.artist}`);
    if (t.genre) parts.push(t.genre);
    if (t.subgenre && t.subgenre !== t.genre) parts.push(t.subgenre);
    if (t.bpm) parts.push(`${Math.round(t.bpm)} BPM`);
    if (t.keyCamelot) parts.push(`key ${t.keyCamelot}`);
    if (t.mood) parts.push(t.mood);
    if (t.vocalType) parts.push(`${t.vocalType} vocals`);
    return parts.join(", ") || "track";
}

/**
 * Build a dataset from the user's music library (the `tracks` table —
 * songs added/scanned by the companion). When no tracks match (e.g.
 * cloud-only dev session before companion sync), gracefully fall back
 * to ready generated_assets on disk so the training pipeline always
 * has real audio to chew on.
 *
 * Items are stored with `assetKind: "library-track"` for tracks and
 * `"generated"` for generated assets, so existing materialization
 * paths keep working for the generated branch. A future companion
 * uploader will handle the library-track branch.
 */
export async function buildDatasetFromLibrary(
    raw: z.infer<typeof BuildFromLibrarySchema>,
): Promise<{ ok: true; dataset: DatasetDto; included: number; source: "tracks" | "generated" } | { ok: false; error: string }> {
    const userId = await uid();
    const parsed = BuildFromLibrarySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid-input: ${parsed.error.message}` };
    const input = parsed.data;

    // 1. Try the real library first via the companion HTTP API
    //    (the `tracks` table lives in the companion's SQLite, not Postgres).
    const link = await getCompanionLink();
    let libRows: CompanionTrack[] = [];
    if (link) {
        try {
            const filters: TrackFilters = {
                pageSize: input.limit,
                page: 1,
                isHidden: false,
                sort: "addedAt",
                order: "desc",
            };
            if (input.genre) filters.genre = input.genre;
            if (input.minBpm !== undefined) filters.minBpm = input.minBpm;
            if (input.maxBpm !== undefined) filters.maxBpm = input.maxBpm;
            if (input.keyCamelot) filters.key = input.keyCamelot;
            const page = await companionLibrary.getTracks(link, filters);
            libRows = page.tracks;
        } catch {
            libRows = [];
        }
    }

    if (libRows.length > 0) {
        const histogram: Record<string, number> = {};
        for (const t of libRows) {
            if (t.genre) histogram[t.genre.toLowerCase()] = (histogram[t.genre.toLowerCase()] ?? 0) + 1;
            if (t.mood) histogram[t.mood.toLowerCase()] = (histogram[t.mood.toLowerCase()] ?? 0) + 1;
        }
        const [ds] = await db
            .insert(trainingDatasets)
            .values({
                userId,
                scope: "user",
                name: input.name,
                description: input.description ?? `Library snapshot (${libRows.length} tracks)`,
                sourceKind: "user-library",
                itemCount: libRows.length,
                totalDurationSec: libRows.reduce((acc, r) => acc + (r.duration ?? 0), 0),
                tagHistogram: histogram,
                status: "draft",
            })
            .returning();
        await db.insert(trainingDatasetItems).values(
            libRows.map((t) => ({
                datasetId: ds.id,
                assetKind: "library-track",
                assetId: String(t.id),
                caption: captionFromTrack(t),
                durationSec: t.duration ?? null,
                sampleRate: t.sampleRate ?? null,
                tempoBpm: t.bpm ?? null,
                keyRoot: t.keyCamelot ?? null,
                tags: [t.genre, t.subgenre, t.mood, t.vocalType].filter((x): x is string => !!x),
                metadata: {
                    title: t.title,
                    artist: t.artist,
                    album: t.album,
                    filepath: t.filepath,
                    sourceUrl: t.sourceUrl,
                    sourcePlatform: t.sourcePlatform,
                    sha256: t.sha256,
                    companionTrackId: t.id,
                } as Record<string, unknown>,
            })),
        );
        return { ok: true, dataset: toDto(ds), included: libRows.length, source: "tracks" };
    }

    // 2. Fallback — library is empty, use ready generated assets on disk.
    if (!input.fallbackToGenerated) {
        return { ok: false, error: "library-empty" };
    }
    const ready = await db
        .select()
        .from(generatedAssets)
        .where(
            and(
                eq(generatedAssets.userId, userId),
                eq(generatedAssets.status, "ready"),
                isNotNull(generatedAssets.filePath),
            ),
        )
        .limit(input.limit);
    if (ready.length === 0) return { ok: false, error: "library-empty-and-no-generated-assets" };

    const res = await buildDatasetFromGeneratedAssets({
        name: input.name,
        description: input.description ?? `Auto-built from ${ready.length} generated assets (library empty fallback)`,
        assetIds: ready.map((a) => a.id),
        captionMode: "promptText",
    });
    if (!res.ok) return res;
    return { ok: true, dataset: res.dataset, included: ready.length, source: "generated" };
}

const BuildFromPackSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    packPath: z.string().min(1).max(500),
});

export async function buildDatasetFromSamplePack(
    raw: z.infer<typeof BuildFromPackSchema>,
): Promise<{ ok: true; dataset: DatasetDto; included: number } | { ok: false; error: string }> {
    const userId = await uid();
    const parsed = BuildFromPackSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `invalid-input: ${parsed.error.message}` };

    const manifestPath = path.join(process.cwd(), "public", "samples", "manifest.json");
    let manifest: SampleManifestJson;
    try {
        manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as SampleManifestJson;
    } catch {
        return { ok: false, error: "sample-manifest-missing" };
    }
    const matchPath = parsed.data.packPath.replace(/^\/+|\/+$/g, "");
    const items: Array<{ path: string; caption: string; duration: number; bpm: number | null }> = [];
    for (const cat of manifest.categories ?? []) {
        for (const g of cat.genres ?? []) {
            const fullPath = `${cat.path.replace(/^\/+/, "")}/${g.path.replace(/^\/+/, "")}`;
            if (!fullPath.startsWith(matchPath)) continue;
            for (const s of g.samples ?? []) {
                items.push({
                    path: s.path,
                    caption: buildCaptionFromSample(cat.label, g.label, s),
                    duration: s.duration ?? 0,
                    bpm: s.bpm ?? null,
                });
            }
        }
    }
    if (items.length === 0) return { ok: false, error: "no-samples-matched" };

    const [ds] = await db
        .insert(trainingDatasets)
        .values({
            userId,
            scope: "user",
            name: parsed.data.name,
            description: parsed.data.description ?? `Sample pack ${matchPath}`,
            sourceKind: "shipped-loops",
            itemCount: items.length,
            totalDurationSec: items.reduce((acc, i) => acc + i.duration, 0),
            tagHistogram: {},
            status: "draft",
        })
        .returning();
    await db.insert(trainingDatasetItems).values(
        items.map((i) => ({
            datasetId: ds.id,
            assetKind: "sample",
            assetId: i.path,
            caption: i.caption,
            durationSec: i.duration,
            tempoBpm: i.bpm,
            metadata: { samplePath: i.path } as Record<string, unknown>,
        })),
    );
    return { ok: true, dataset: toDto(ds), included: items.length };
}

interface SampleManifestJson {
    categories?: Array<{
        label: string;
        path: string;
        genres?: Array<{
            label: string;
            path: string;
            samples?: Array<{
                path: string;
                name: string;
                duration?: number;
                bpm?: number | null;
                key?: string | null;
                type?: string;
                oneshot?: boolean;
            }>;
        }>;
    }>;
}

function buildCaptionFromSample(
    catLabel: string,
    genreLabel: string,
    s: { name: string; bpm?: number | null; key?: string | null; type?: string; oneshot?: boolean },
): string {
    const parts: string[] = [];
    parts.push(`${genreLabel}`);
    if (s.type) parts.push(s.type);
    if (s.oneshot) parts.push("one-shot");
    if (s.bpm) parts.push(`${s.bpm} BPM`);
    if (s.key) parts.push(s.key);
    parts.push(catLabel.toLowerCase());
    return parts.join(", ");
}

function deriveTagHistogram(assets: Array<typeof generatedAssets.$inferSelect>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const a of assets) {
        const tokens = (a.promptText ?? "")
            .toLowerCase()
            .split(/[,\s]+/)
            .filter((t) => t.length > 2 && t.length < 20)
            .slice(0, 10);
        for (const t of tokens) counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
}

// ─── Caption tagging ────────────────────────────────────────────────────

export async function setDatasetItemCaption(
    datasetId: string,
    itemId: string,
    caption: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const userId = await uid();
    const [ds] = await db
        .select({ userId: trainingDatasets.userId, scope: trainingDatasets.scope })
        .from(trainingDatasets)
        .where(eq(trainingDatasets.id, datasetId))
        .limit(1);
    if (!ds) return { ok: false, error: "dataset-not-found" };
    if (ds.scope === "user" && ds.userId !== userId) return { ok: false, error: "forbidden" };
    await db
        .update(trainingDatasetItems)
        .set({ caption: caption.slice(0, 2000) })
        .where(and(eq(trainingDatasetItems.id, itemId), eq(trainingDatasetItems.datasetId, datasetId)));
    return { ok: true };
}

export async function setDatasetItemWeight(
    datasetId: string,
    itemId: string,
    weight: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const userId = await uid();
    const [ds] = await db
        .select({ userId: trainingDatasets.userId, scope: trainingDatasets.scope })
        .from(trainingDatasets)
        .where(eq(trainingDatasets.id, datasetId))
        .limit(1);
    if (!ds) return { ok: false, error: "dataset-not-found" };
    if (ds.scope === "user" && ds.userId !== userId) return { ok: false, error: "forbidden" };
    const w = Math.max(0, Math.min(10, weight));
    await db
        .update(trainingDatasetItems)
        .set({ weight: w })
        .where(and(eq(trainingDatasetItems.id, itemId), eq(trainingDatasetItems.datasetId, datasetId)));
    return { ok: true };
}

// ─── Materialize ────────────────────────────────────────────────────────

/** Stream each library track from the companion and upload to GCS in
 *  the layout the ACE-Step trainer expects:
 *      gs://<bucket>/<jobId>/dataset/<n>/audio.<ext>
 *      gs://<bucket>/<jobId>/dataset/<n>/text.txt
 *  Concurrency cap 3 to keep the companion happy on residential disks. */
async function materializeLibraryTracks(
    items: Array<{ assetId: string; caption: string | null }>,
    jobId: string,
): Promise<{ ok: true; datasetUri: string; fileCount: number } | { ok: false; error: string }> {
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "no-companion-link" };
    const { Storage } = await import("@google-cloud/storage");
    const b64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
    const storage = b64 && b64.length > 100
        ? new Storage({ credentials: JSON.parse(Buffer.from(b64, "base64").toString("utf8")) })
        : new Storage();
    const bucketName = process.env.GCS_TRAINING_BUCKET ?? "mmo-training-prod";
    const bucket = storage.bucket(bucketName);
    const datasetPrefix = `${jobId}/dataset`;
    const errors: string[] = [];
    let cursor = 0;
    let uploaded = 0;
    const concurrency = 3;

    async function worker() {
        while (cursor < items.length) {
            const idx = cursor++;
            const it = items[idx];
            const trackId = Number(it.assetId);
            if (!Number.isFinite(trackId)) {
                errors.push(`item[${idx}]: bad assetId`);
                continue;
            }
            try {
                const res = await companionLibrary.fetchTrackAudio(link!, trackId);
                const ct = res.headers.get("content-type") ?? "audio/mpeg";
                const ext = ct.includes("wav") ? "wav"
                    : ct.includes("flac") ? "flac"
                    : ct.includes("aac") ? "m4a"
                    : ct.includes("ogg") ? "ogg"
                    : "mp3";
                const audioKey = `${datasetPrefix}/${idx}/audio.${ext}`;
                const textKey = `${datasetPrefix}/${idx}/text.txt`;
                const file = bucket.file(audioKey);
                // Stream the companion response straight into GCS.
                if (!res.body) throw new Error("empty-body");
                const buf = Buffer.from(await res.arrayBuffer());
                await file.save(buf, { contentType: ct });
                await bucket.file(textKey).save(it.caption ?? "track", {
                    contentType: "text/plain; charset=utf-8",
                });
                uploaded++;
            } catch (e) {
                errors.push(`item[${idx}]: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));

    if (uploaded === 0) {
        return { ok: false, error: `all-uploads-failed: ${errors.slice(0, 3).join("; ")}` };
    }
    return {
        ok: true,
        datasetUri: `gs://${bucketName}/${datasetPrefix}/`,
        fileCount: uploaded,
    };
}

/** Upload dataset items to GCS so a trainer can read them. For
 *  generated-asset datasets we reuse `prepareAceStepDataset` which
 *  already implements the GCS layout the trainer expects. Returns
 *  `{ gcsUri }` and stamps the dataset row. */
export async function materializeDataset(
    datasetId: string,
): Promise<{ ok: true; gcsUri: string } | { ok: false; error: string }> {
    const userId = await uid();
    const [ds] = await db
        .select()
        .from(trainingDatasets)
        .where(eq(trainingDatasets.id, datasetId))
        .limit(1);
    if (!ds) return { ok: false, error: "dataset-not-found" };
    if (ds.scope === "user" && ds.userId !== userId) return { ok: false, error: "forbidden" };
    if (ds.gcsUri && ds.status === "ready") return { ok: true, gcsUri: ds.gcsUri };

    await db
        .update(trainingDatasets)
        .set({ status: "materializing", updatedAt: new Date() })
        .where(eq(trainingDatasets.id, datasetId));

    try {
        if (ds.sourceKind === "user-library" || ds.sourceKind === "thumbs-up") {
            // user-library can hold library-track items (real songs streamed
            // from the companion) and/or generated items (fallback path).
            // Materialize whichever subset is present.
            const items = await db
                .select({
                    assetKind: trainingDatasetItems.assetKind,
                    assetId: trainingDatasetItems.assetId,
                    caption: trainingDatasetItems.caption,
                })
                .from(trainingDatasetItems)
                .where(eq(trainingDatasetItems.datasetId, datasetId));
            const generatedIds = items.filter((i) => i.assetKind === "generated").map((i) => i.assetId);
            const libraryItems = items.filter((i) => i.assetKind === "library-track");
            if (libraryItems.length > 0) {
                const res = await materializeLibraryTracks(libraryItems, `ds-${datasetId}`);
                if (!res.ok) throw new Error(res.error);
                await db
                    .update(trainingDatasets)
                    .set({ status: "ready", gcsUri: res.datasetUri, updatedAt: new Date() })
                    .where(eq(trainingDatasets.id, datasetId));
                return { ok: true, gcsUri: res.datasetUri };
            }
            if (generatedIds.length === 0) throw new Error("no-items-to-materialize");
            const res = await prepareAceStepDataset({ assetIds: generatedIds, jobId: `ds-${datasetId}` });
            if (!res.ok) throw new Error(res.error);
            await db
                .update(trainingDatasets)
                .set({ status: "ready", gcsUri: res.datasetUri, updatedAt: new Date() })
                .where(eq(trainingDatasets.id, datasetId));
            return { ok: true, gcsUri: res.datasetUri };
        }
        // sample-pack & external: caller (or a future Cloud Run job) must
        // upload directly. We just stamp the URI convention.
        const bucket = process.env.GCS_TRAINING_BUCKET ?? "mmo-training-prod";
        const uri = `gs://${bucket}/ds-${datasetId}/dataset/`;
        await db
            .update(trainingDatasets)
            .set({ status: "ready", gcsUri: uri, updatedAt: new Date() })
            .where(eq(trainingDatasets.id, datasetId));
        return { ok: true, gcsUri: uri };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db
            .update(trainingDatasets)
            .set({ status: "failed", error: msg, updatedAt: new Date() })
            .where(eq(trainingDatasets.id, datasetId));
        return { ok: false, error: msg };
    }
}

// ─── Archive ────────────────────────────────────────────────────────────

export async function archiveDataset(datasetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const userId = await uid();
    const [ds] = await db
        .select()
        .from(trainingDatasets)
        .where(and(eq(trainingDatasets.id, datasetId), eq(trainingDatasets.userId, userId)))
        .limit(1);
    if (!ds) return { ok: false, error: "dataset-not-found" };
    await db
        .update(trainingDatasets)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(trainingDatasets.id, datasetId));
    return { ok: true };
}
