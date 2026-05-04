/**
 * Plugin host orchestrator (companion side).
 *
 * Hosts VST3 / AU / LV2 audio plugins via Spotify's `pedalboard`
 * Python library (which wraps JUCE under the hood). Communication
 * piggy-backs on the existing analyzer Python sidecar — the same
 * long-running process handles both DSP analysis and plugin work.
 *
 * Responsibilities:
 *   • In-memory cache of the last successful plugin scan, persisted
 *     to <userData>/plugins.json so the UI shows results instantly
 *     on next companion launch (rescan is opt-in).
 *   • Render queue for offline plugin chains (Sound Editor / DAW /
 *     Live recording post-FX). Realtime preview is intentionally
 *     out of scope for v0.8.0 — see plugins/host.ts header notes.
 *   • Output WAVs are written to <userData>/plugin-renders/<jobId>.wav
 *     and served by the plugin routes via HTTP-range so the web app
 *     can stream them into a WaveSurfer / Web Audio buffer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { analyzer } from "../library/analyzer";

// ─── Types ───────────────────────────────────────────────────────────

export interface PluginParameter {
    id: string;
    name: string;
    label?: string;
    type?: string;
    min_value?: number;
    max_value?: number;
    step_size?: number;
    valid_values?: string[];
    string_value?: string;
    raw_value?: number;
    default_raw_value?: number;
}

export interface PluginDescriptor {
    path: string;
    name: string;
    manufacturer: string;
    format: "VST3" | "AU" | "LV2" | "?";
    isInstrument: boolean;
    isEffect: boolean;
    parameters: PluginParameter[];
}

export interface PluginScanResult {
    scannedAt: number;
    inventory: PluginDescriptor[];
    failures: Array<{ path: string; error: string }>;
    roots: string[];
}

export interface PluginChainStep {
    /** Absolute path to a `.vst3` / `.component` / `.lv2` bundle. */
    path: string;
    /** Optional parameter overrides keyed by `parameter.id`. Values
     *  can be raw (0..1) or in the parameter's natural units; the
     *  Python side coerces. */
    params?: Record<string, number | string | boolean>;
    /** Whether this step is bypassed (skipped during render). */
    bypass?: boolean;
}

export interface PluginRenderJob {
    id: string;
    inputPath: string;
    outputPath: string;
    chain: PluginChainStep[];
    enqueuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    progress: number;     // 0..1
    stage: string;        // "queued" | "render" | "done" | "error"
    message: string;
    durationSec?: number;
    error?: string;
}

// ─── Singleton ───────────────────────────────────────────────────────

class PluginHost extends EventEmitter {
    private scanCache: PluginScanResult | null = null;
    private scanPromise: Promise<PluginScanResult> | null = null;
    private renders: PluginRenderJob[] = [];

    /** <userData>/plugin-renders — persistent render output dir. */
    private rendersRoot(): string {
        const base = (() => {
            try { return app.getPath("userData"); } catch { return process.cwd(); }
        })();
        const root = path.join(base, "plugin-renders");
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
        return root;
    }

    /** <userData>/plugins.json — cached scan result. */
    private cachePath(): string {
        const base = (() => {
            try { return app.getPath("userData"); } catch { return process.cwd(); }
        })();
        return path.join(base, "plugins.json");
    }

    /** Load the cached inventory from disk if present. Idempotent. */
    private loadCache(): PluginScanResult | null {
        if (this.scanCache) return this.scanCache;
        try {
            const raw = readFileSync(this.cachePath(), "utf8");
            const parsed = JSON.parse(raw) as PluginScanResult;
            if (parsed && Array.isArray(parsed.inventory)) {
                this.scanCache = parsed;
                return parsed;
            }
        } catch {
            // file missing or corrupt — fall through, caller will scan.
        }
        return null;
    }

    private saveCache(result: PluginScanResult) {
        try {
            writeFileSync(this.cachePath(), JSON.stringify(result, null, 2), "utf8");
        } catch (e) {
            console.error("[plugins] cache write failed:", e);
        }
    }

    // ─── Public API ──────────────────────────────────────────────────

    /** Returns the cached inventory if available, else null. The web
     *  app uses this for an instant first paint on the plugins page;
     *  if null it shows a "no scan yet" CTA pointing at `scan()`. */
    getCached(): PluginScanResult | null {
        return this.loadCache();
    }

    /** Walk the OS-standard plugin directories (+ optional extras),
     *  attempt to load each candidate, and return + cache the result.
     *  Concurrent scan calls share the same in-flight promise.
     *
     *  @param extraPaths User-configured plugin directories. Combined
     *                    with the OS defaults.
     *  @param onProgress Streaming callback for the scan progress bar.
     */
    async scan(
        extraPaths: string[] = [],
        onProgress?: (p: { pct: number; msg: string }) => void,
    ): Promise<PluginScanResult> {
        if (this.scanPromise) return this.scanPromise;
        const promise = (async () => {
            try {
                const data = await analyzer.sendCommand<PluginScanResult>(
                    "plugins.scan",
                    { paths: extraPaths },
                    (p) => onProgress?.({ pct: p.pct, msg: p.msg }),
                    10 * 60_000, // scans of large libraries can take minutes
                );
                this.scanCache = data;
                this.saveCache(data);
                this.emit("scan", data);
                return data;
            } finally {
                this.scanPromise = null;
            }
        })();
        this.scanPromise = promise;
        return promise;
    }

    /** Probe a single plugin's parameter list. Used when the user
     *  opens a plugin in the rack (the cache stores parameters too,
     *  but stale caches happen — describing on demand keeps the UI
     *  honest). */
    async describe(pluginPath: string): Promise<PluginDescriptor> {
        return analyzer.sendCommand<PluginDescriptor>(
            "plugins.describe",
            { path: pluginPath },
            undefined,
            60_000,
        );
    }

    /** Render `inputPath` through `chain` and write the result.
     *
     *  We allocate the output path under <userData>/plugin-renders/
     *  so the companion can serve it via HTTP. The web app receives
     *  the job id and polls/streams progress until `done`, then GETs
     *  the rendered audio.
     */
    async render(
        inputPath: string,
        chain: PluginChainStep[],
    ): Promise<PluginRenderJob> {
        if (!existsSync(inputPath)) {
            throw new Error(`input file not found: ${inputPath}`);
        }
        const enabled = chain.filter((s) => !s.bypass);
        if (enabled.length === 0) {
            throw new Error("plugin chain is empty (or all steps bypassed)");
        }
        const job: PluginRenderJob = {
            id: randomUUID(),
            inputPath,
            outputPath: path.join(this.rendersRoot(), `${randomUUID()}.wav`),
            chain,
            enqueuedAt: Date.now(),
            progress: 0,
            stage: "queued",
            message: "Queued",
        };
        this.renders.push(job);
        if (this.renders.length > 32) this.renders.shift();
        this.emit("render-start", job);

        // Run async; caller awaits via findRender/status polling.
        void this.runRender(job, enabled);
        return job;
    }

    private async runRender(job: PluginRenderJob, enabled: PluginChainStep[]) {
        job.startedAt = Date.now();
        job.stage = "render";
        job.message = "Loading audio…";
        try {
            const data = await analyzer.sendCommand<{
                ok: boolean;
                output: string;
                durationSec: number;
                sampleRate: number;
                channels: number;
            }>(
                "plugins.render",
                {
                    input: job.inputPath,
                    output: job.outputPath,
                    chain: enabled.map((s) => ({ path: s.path, params: s.params ?? {} })),
                },
                (p) => {
                    job.progress = p.pct;
                    job.message = p.msg;
                    this.emit("render-progress", job);
                },
                30 * 60_000, // long renders (whole tracks through heavy chains)
            );
            job.finishedAt = Date.now();
            job.progress = 1;
            job.stage = "done";
            job.message = "Complete";
            job.durationSec = data.durationSec;
            this.emit("render-complete", job);
        } catch (e) {
            job.finishedAt = Date.now();
            job.stage = "error";
            job.error = e instanceof Error ? e.message : String(e);
            job.message = job.error;
            this.emit("render-error", job);
        }
    }

    findRender(id: string): PluginRenderJob | null {
        return this.renders.find((j) => j.id === id) ?? null;
    }

    status() {
        return {
            inventory: this.scanCache?.inventory.length ?? 0,
            scannedAt: this.scanCache?.scannedAt ?? null,
            renders: this.renders.slice(-16).map((j) => ({
                id: j.id,
                stage: j.stage,
                progress: j.progress,
                message: j.message,
                error: j.error,
                startedAt: j.startedAt,
                finishedAt: j.finishedAt,
                durationSec: j.durationSec,
            })),
        };
    }

    /** Resolve a render job's output path for streaming. Returns null
     *  if the job is unknown or hasn't completed yet. */
    renderOutputPath(id: string): string | null {
        const job = this.findRender(id);
        if (!job) return null;
        if (job.stage !== "done") return null;
        if (!existsSync(job.outputPath)) return null;
        return job.outputPath;
    }
}

export const pluginHost = new PluginHost();
