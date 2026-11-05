/**
 * Feeds the subtitle text index (`media/subtitles.ts`) from the video registry.
 * Sidecars and already-extracted WebVTT are indexed inline (pure fs). Embedded text tracks that were
 * never extracted are extracted by ONE ffmpeg pass inside the global analysis slot — and only when a
 * client explicitly asks (`POST /media/subtitles/index`).
 */

import { resolveFileId, fileRegistry } from "./video-registry";
import { withAnalysisSlot } from "./ffmpeg-jobs";
import { cachedSubtitleVtts, isBitmapSub, subtitleVttPath } from "./video-subs";
import type { SubtitleIndex } from "../media/subtitles";

export type IndexState = "queued" | "running" | "done" | "failed";

export interface IndexJob {
    fileId: string;
    state: IndexState;
    externalCues: number;
    embeddedCues: number;
    error: string | null;
    startedAt: number;
    finishedAt: number | null;
}

type SubMeta = { subtitleTracks?: Array<{ codec: string; lang?: string | null; title?: string | null }> };

export interface SubtitleIndexerDeps {
    index: SubtitleIndex;
    resolve?: (fileId: string) => { absPath: string; meta: SubMeta } | null;
    slot?: <T>(fn: () => Promise<T>) => Promise<T>;
    /** Extract every text track (one pass); default = video-subs cache. */
    extract?: (fileId: string, absPath: string, tracks: Array<{ codec: string }>) => Promise<void>;
    cached?: (fileId: string, absPath: string) => { index: number; path: string; sig: string }[];
    now?: () => number;
}

export class SubtitleIndexer {
    private readonly jobs = new Map<string, IndexJob>();
    private readonly now: () => number;

    constructor(private readonly deps: SubtitleIndexerDeps) {
        this.now = deps.now ?? Date.now;
    }

    private resolve(fileId: string): { absPath: string; meta: SubMeta } | null {
        if (this.deps.resolve) return this.deps.resolve(fileId);
        const abs = resolveFileId(fileId);
        return abs ? { absPath: abs, meta: (fileRegistry.get(fileId)?.meta ?? {}) as SubMeta } : null;
    }

    private cachedVtts(fileId: string, absPath: string, meta: SubMeta) {
        const tracks = meta.subtitleTracks ?? [];
        return (this.deps.cached ?? cachedSubtitleVtts)(fileId, absPath).map((v) => ({
            ...v, lang: tracks[v.index]?.lang ?? null, label: tracks[v.index]?.title ?? null,
        }));
    }

    /** Inline, no ffmpeg: sidecars + already-extracted tracks. Null when the fileId is unknown. */
    indexCheap(fileId: string): { externalCues: number; embeddedCues: number } | null {
        const f = this.resolve(fileId);
        if (!f) return null;
        const externalCues = this.deps.index.indexSidecars(fileId, f.absPath);
        const embeddedCues = this.deps.index.indexEmbeddedVtts(fileId, this.cachedVtts(fileId, f.absPath, f.meta));
        return { externalCues, embeddedCues };
    }

    job(fileId: string): IndexJob | null {
        const j = this.jobs.get(fileId);
        return j ? { ...j } : null;
    }

    /** Full index of one file; embedded extraction is queued in the analysis slot. */
    request(fileId: string): IndexJob | null {
        const f = this.resolve(fileId);
        if (!f) return null;
        const running = this.jobs.get(fileId);
        if (running && (running.state === "queued" || running.state === "running")) return { ...running };
        const cheap = this.indexCheap(fileId)!;
        const tracks = f.meta.subtitleTracks ?? [];
        const textTracks = tracks.map((t, i) => ({ i, ok: !isBitmapSub(t.codec) })).filter((t) => t.ok);
        const extracted = new Set(this.cachedVtts(fileId, f.absPath, f.meta).map((v) => v.index));
        const missing = textTracks.filter((t) => !extracted.has(t.i));
        const job: IndexJob = {
            fileId, state: missing.length === 0 ? "done" : "queued", externalCues: cheap.externalCues, embeddedCues: cheap.embeddedCues,
            error: null, startedAt: this.now(), finishedAt: missing.length === 0 ? this.now() : null,
        };
        this.jobs.set(fileId, job);
        if (missing.length === 0) return { ...job };
        const extract = this.deps.extract ?? (async (id: string, abs: string, tr: Array<{ codec: string }>) => {
            // First text ordinal triggers the one-pass extraction of all text tracks (video-subs cache).
            await subtitleVttPath(id, abs, missing[0]!.i, tr);
        });
        const slot = this.deps.slot ?? withAnalysisSlot;
        void slot(async () => {
            job.state = "running";
            await extract(fileId, f.absPath, tracks);
            job.embeddedCues += this.deps.index.indexEmbeddedVtts(fileId, this.cachedVtts(fileId, f.absPath, f.meta));
            job.state = "done";
            job.finishedAt = this.now();
        }).catch((err: unknown) => {
            job.state = "failed";
            job.error = err instanceof Error ? err.message : String(err);
            job.finishedAt = this.now();
        });
        return { ...job };
    }

    /** Sidecars + cached tracks of every registered file (no ffmpeg). */
    indexLibraryCheap(fileIds: string[]): { files: number; cues: number } {
        let cues = 0;
        let files = 0;
        for (const id of fileIds) {
            const r = this.indexCheap(id);
            if (!r) continue;
            files++;
            cues += r.externalCues + r.embeddedCues;
        }
        return { files, cues };
    }
}
