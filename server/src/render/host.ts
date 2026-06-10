/**
 * Companion-side project render job queue.
 *
 * Phase E (P6): the web app already does the full OfflineAudioContext
 * bounce in `DAWEngine.exportProject()`. This host exists so a project
 * render can be persisted on the companion (so paired devices can pull
 * it via /render/:jobId/download) without re-implementing the audio
 * pipeline natively.
 *
 * Lifecycle:
 *   1. POST /render/start         → enqueue → `queued`
 *   2. POST /render/:id/upload    → write bytes → `ready`
 *   3. GET  /render/:id           → poll status
 *   4. GET  /render/:id/download  → stream WAV/MP3
 *
 * The native audio engine offline-render mode (`RenderMode` TODO in
 * server/src/audio/native-engine.ts) is out of scope for this phase;
 * when it lands, swap the upload step for a direct engine.render() call
 * and keep the rest of the surface area identical.
 */

import { existsSync, mkdirSync, statSync, createReadStream, createWriteStream, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

let appRef: { getPath: (k: string) => string } | null = null;
try { appRef = require("electron").app; } catch { /* not running under electron */ }

export type RenderStage = "queued" | "uploading" | "ready" | "error";
export type RenderFormat = "wav" | "mp3";
export type RenderMode = "upload" | "native";

export interface RenderJob {
    id: string;
    projectExternalId: string;
    format: RenderFormat;
    /** How the bytes get on disk. `upload` = web app POSTs the bounce.
     *  `native` = (future) companion does an in-process render. */
    mode: RenderMode;
    stage: RenderStage;
    bytes: number;
    error?: string;
    createdAt: number;
    finishedAt?: number;
}

class RenderHost {
    private jobs = new Map<string, RenderJob>();
    private loaded = false;

    private outputDir(): string {
        const base = appRef?.getPath ? appRef.getPath("userData") : process.cwd();
        const dir = path.join(base, "project-renders");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    private indexPath(): string {
        return path.join(this.outputDir(), "jobs.json");
    }

    private loadFromDisk(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = readFileSync(this.indexPath(), "utf8");
            const parsed = JSON.parse(raw) as RenderJob[];
            if (Array.isArray(parsed)) {
                for (const j of parsed) {
                    // Mark interrupted uploads as errored on restart \u2014 we
                    // have no way to resume a half-written stream.
                    if (j.stage === "uploading" || j.stage === "queued") {
                        j.stage = "error";
                        j.error = j.error ?? "interrupted by restart";
                    }
                    this.jobs.set(j.id, j);
                }
            }
        } catch { /* missing or unreadable index */ }
    }

    private persist(): void {
        try {
            writeFileSync(this.indexPath(), JSON.stringify(Array.from(this.jobs.values()), null, 2));
        } catch { /* best effort */ }
    }

    private filePath(job: RenderJob): string {
        const ext = job.format === "mp3" ? "mp3" : "wav";
        return path.join(this.outputDir(), `${job.id}.${ext}`);
    }

    start(projectExternalId: string, format: RenderFormat = "wav", mode: RenderMode = "upload"): RenderJob {
        this.loadFromDisk();
        const job: RenderJob = {
            id: randomUUID(),
            projectExternalId,
            format,
            mode,
            stage: "queued",
            bytes: 0,
            createdAt: Date.now(),
        };
        this.jobs.set(job.id, job);
        this.persist();
        return job;
    }

    get(id: string): RenderJob | undefined {
        this.loadFromDisk();
        return this.jobs.get(id);
    }

    list(): RenderJob[] {
        this.loadFromDisk();
        return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Write the rendered audio bytes to disk and mark the job ready.
     *  Returns a stream that the route handler can pipe the request body
     *  into. The caller resolves the returned promise once the request
     *  body has been fully consumed. */
    upload(id: string): { job: RenderJob; sink: NodeJS.WritableStream; finalize: (ok: boolean, err?: string) => void } | null {
        this.loadFromDisk();
        const job = this.jobs.get(id);
        if (!job) return null;
        job.stage = "uploading";
        this.persist();
        const target = this.filePath(job);
        const sink = createWriteStream(target);
        return {
            job,
            sink,
            finalize: (ok, err) => {
                if (ok) {
                    try {
                        job.bytes = statSync(target).size;
                        job.stage = "ready";
                        job.finishedAt = Date.now();
                    } catch (e) {
                        job.stage = "error";
                        job.error = e instanceof Error ? e.message : String(e);
                    }
                } else {
                    job.stage = "error";
                    job.error = err ?? "upload aborted";
                    try { unlinkSync(target); } catch { /* noop */ }
                }
                this.persist();
            },
        };
    }

    download(id: string): { job: RenderJob; path: string; size: number } | null {
        this.loadFromDisk();
        const job = this.jobs.get(id);
        if (!job || job.stage !== "ready") return null;
        const p = this.filePath(job);
        if (!existsSync(p)) return null;
        return { job, path: p, size: statSync(p).size };
    }

    /** Remove a job and its on-disk artifact. Idempotent. */
    remove(id: string): boolean {
        this.loadFromDisk();
        const job = this.jobs.get(id);
        if (!job) return false;
        const p = this.filePath(job);
        try { unlinkSync(p); } catch { /* not present */ }
        this.jobs.delete(id);
        this.persist();
        return true;
    }
}

export const renderHost = new RenderHost();
