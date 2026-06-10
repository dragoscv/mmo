/**
 * Generic Python sidecar host.
 *
 * Extracted from the original `VoiceHost` so every model lane in MMO
 * (voice cloning, RVC voice conversion, ACE-Step song generation,
 * Demucs stem separation, future engines) can share the same:
 *
 *   • Long-lived Python child process with stdio NDJSON IPC.
 *   • Hello-event-based readiness + 30s startup timeout.
 *   • Per-request `id` correlation with per-request timeout + progress
 *     callbacks.
 *   • Dev-mode fs.watch auto-restart when the .py file is edited.
 *   • Crash-safe cleanup that rejects every pending request.
 *
 * Wire protocol (unchanged from voice_clone.py):
 *
 *   ← hello   { kind: "hello", engineId?, version?, capabilities?, device?, ... }
 *   →         { id, kind, ...args }
 *   ← progress { id, kind:"progress", stage, pct, msg }
 *   ← result  { id, kind:"result", ok, data? | error? }
 *
 * Sidecars are entirely transport. Domain logic (voices CRUD, render
 * paths, etc.) stays in the caller (e.g. VoiceHost). One sidecar
 * instance = one long-lived Python process.
 */

import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { log } from "../lib/logger";

export interface SidecarDevice {
    type: string;
    name?: string;
    vramGb?: number;
}

export interface SidecarHello {
    engineId?: string;
    version?: string;
    capabilities?: string[];
    device?: SidecarDevice;
    /** Engine-specific extras forwarded verbatim from the python `hello`. */
    [k: string]: unknown;
}

export interface SidecarOptions {
    /** Short label used in log keys (e.g. "voice", "rvc", "ace-step"). */
    name: string;
    /** Absolute path to the .py entrypoint. */
    scriptPath: string;
    /** Python exe override; defaults to `MMO_PYTHON` env or platform default. */
    pythonExe?: string;
    /** Extra env vars merged on top of `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Hello timeout in ms (default 30_000). */
    helloTimeoutMs?: number;
    /** Restart on script-file change (dev convenience). Default true. */
    watchForRestart?: boolean;
    /** Extra CLI args after the script path. */
    args?: string[];
    /** Auto-kill the python child after this many ms of idleness
     *  (no pending jobs and no `send()` in the meantime). The next
     *  call to `send()` respawns it. Use this on GPU-heavy engines so
     *  VRAM is freed between user actions; omit (or set 0) to keep
     *  the model resident forever. */
    idleEvictMs?: number;
}

export interface SidecarProgress {
    stage: string;
    pct: number;
    msg: string;
}

type ProgressFn = (p: SidecarProgress) => void;

interface PendingJob {
    id: string;
    resolve: (data: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    onProgress?: ProgressFn;
    timer: NodeJS.Timeout;
}

export class Sidecar extends EventEmitter {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private buf = "";
    private pending = new Map<string, PendingJob>();
    private readyFlag = false;
    private readyPromise: Promise<SidecarHello> | null = null;
    private resolveReady: ((h: SidecarHello) => void) | null = null;
    private rejectReady: ((err: Error) => void) | null = null;
    private helloPayload: SidecarHello | null = null;
    private scriptWatcher: FSWatcher | null = null;
    private idleTimer: NodeJS.Timeout | null = null;

    constructor(private readonly opts: SidecarOptions) {
        super();
    }

    get name(): string { return this.opts.name; }
    get isReady(): boolean { return this.readyFlag; }
    get hello(): SidecarHello | null { return this.helloPayload; }
    get pendingCount(): number { return this.pending.size; }

    /** Spawn (if needed) and resolve when the python `hello` lands. */
    async ready(): Promise<SidecarHello> {
        if (this.readyFlag && this.helloPayload) return this.helloPayload;
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = new Promise<SidecarHello>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
            try { this.spawnProc(); } catch (e) {
                this.rejectReady?.(e instanceof Error ? e : new Error(String(e)));
                this.cleanup();
            }
        });
        return this.readyPromise;
    }

    /** Send a request and await its `result`. Rejects on timeout or sidecar crash. */
    async send(
        kind: string,
        args: Record<string, unknown>,
        timeoutMs: number,
        onProgress?: ProgressFn,
    ): Promise<Record<string, unknown>> {
        this.cancelIdleEviction();
        await this.ready();
        if (!this.proc || !this.proc.stdin.writable) {
            throw new Error(`${this.opts.name}-sidecar-not-ready`);
        }
        const id = randomUUID();
        return new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.maybeScheduleIdleEviction();
                reject(new Error(`${this.opts.name}-job-timeout`));
            }, timeoutMs);
            const wrappedResolve = (data: Record<string, unknown>) => {
                this.maybeScheduleIdleEviction();
                resolve(data);
            };
            const wrappedReject = (err: Error) => {
                this.maybeScheduleIdleEviction();
                reject(err);
            };
            this.pending.set(id, { id, resolve: wrappedResolve, reject: wrappedReject, onProgress, timer });
            // Python `_sidecar.py::_dispatch` reads `job.get("args")` — must
            // be a nested dict, not spread at top-level (only `id` + `kind`
            // are top-level protocol fields).
            const payload = JSON.stringify({ id, kind, args }) + "\n";
            this.proc!.stdin.write(payload, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    this.maybeScheduleIdleEviction();
                    reject(err);
                }
            });
        });
    }

    /** Kill the python child (e.g. on app shutdown). Pending requests reject. */
    dispose(): void {
        this.cancelIdleEviction();
        if (this.scriptWatcher) {
            try { this.scriptWatcher.close(); } catch { /* noop */ }
            this.scriptWatcher = null;
        }
        if (this.proc) {
            try { this.proc.kill(); } catch { /* noop */ }
        }
        // exit handler will run cleanup() and reject pending
    }

    // ─── idle eviction ─────────────────────────────────────────────

    private maybeScheduleIdleEviction(): void {
        const ms = this.opts.idleEvictMs ?? 0;
        if (!ms || ms <= 0) return;
        if (this.pending.size > 0) return;
        this.cancelIdleEviction();
        this.idleTimer = setTimeout(() => {
            if (this.pending.size > 0) return; // raced with a new job
            log.info(`${this.opts.name}.sidecar.idle-evict`, { afterMs: ms });
            try { this.proc?.kill(); } catch { /* noop */ }
        }, ms);
        this.idleTimer.unref();
    }

    private cancelIdleEviction(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    // ─── internals ──────────────────────────────────────────────────

    private pythonExe(): string {
        return this.opts.pythonExe
            ?? process.env.MMO_PYTHON
            ?? (process.platform === "win32" ? "python" : "python3");
    }

    private spawnProc(): void {
        if (!existsSync(this.opts.scriptPath)) {
            throw new Error(`${this.opts.name}-script-missing: ${this.opts.scriptPath}`);
        }
        const env = { ...process.env, ...(this.opts.env ?? {}) };
        const args = [this.opts.scriptPath, ...(this.opts.args ?? [])];
        const child = spawn(this.pythonExe(), args, {
            stdio: ["pipe", "pipe", "pipe"],
            env,
        });
        this.proc = child;
        if (this.opts.watchForRestart !== false) this.watchScriptForRestart();

        child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
            log.warn(`${this.opts.name}.sidecar.stderr`, { tail: chunk.toString().slice(0, 500) });
        });
        child.on("error", (err) => {
            log.error(`${this.opts.name}.sidecar.spawn-failed`, err);
            this.rejectReady?.(new Error(
                `${this.opts.name}-sidecar spawn failed: ${err.message}. Set MMO_PYTHON if python is not on PATH.`,
            ));
            this.failPending(new Error(`${this.opts.name}-sidecar-spawn-error`));
            this.cleanup();
        });
        child.on("exit", (code) => {
            log.warn(`${this.opts.name}.sidecar.exit`, { code });
            const err = new Error(`${this.opts.name}-sidecar exited (${code})`);
            if (!this.readyFlag) this.rejectReady?.(err);
            this.failPending(err);
            this.cleanup();
            this.emit("exit", code);
        });

        const helloMs = this.opts.helloTimeoutMs ?? 30_000;
        setTimeout(() => {
            if (!this.readyFlag) {
                this.rejectReady?.(new Error(
                    `${this.opts.name}-sidecar did not emit hello within ${helloMs}ms`,
                ));
            }
        }, helloMs).unref();
    }

    private failPending(err: Error): void {
        for (const job of this.pending.values()) {
            clearTimeout(job.timer);
            job.reject(err);
        }
        this.pending.clear();
    }

    private cleanup(): void {
        this.proc = null;
        this.readyFlag = false;
        this.readyPromise = null;
        this.resolveReady = null;
        this.rejectReady = null;
        this.cancelIdleEviction();
        if (this.scriptWatcher) {
            try { this.scriptWatcher.close(); } catch { /* noop */ }
            this.scriptWatcher = null;
        }
    }

    // Dev convenience: when the .py file changes on disk, kill the running
    // sidecar so the next request respawns it with fresh code. Avoids the
    // "why is my fix not applied?" footgun where a Python singleton keeps
    // running bytecode from before the edit.
    private watchScriptForRestart(): void {
        if (this.scriptWatcher) return;
        if (!existsSync(this.opts.scriptPath)) return;
        let debounce: NodeJS.Timeout | null = null;
        try {
            this.scriptWatcher = fsWatch(this.opts.scriptPath, () => {
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(() => {
                    if (!this.proc) return;
                    log.warn(`${this.opts.name}.sidecar.restart-on-change`, {
                        scriptPath: this.opts.scriptPath,
                    });
                    try { this.proc.kill(); } catch { /* noop */ }
                }, 250);
            });
        } catch (e) {
            log.warn(`${this.opts.name}.sidecar.watch-failed`, {
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    private onStdout(chunk: Buffer): void {
        this.buf += chunk.toString();
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let evt: Record<string, unknown>;
            try {
                evt = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            const kind = evt.kind as string | undefined;
            if (kind === "hello") {
                this.helloPayload = evt as SidecarHello;
                this.readyFlag = true;
                log.info(`${this.opts.name}.sidecar.ready`, {
                    device: evt.device,
                    engineId: evt.engineId,
                    capabilities: evt.capabilities,
                });
                this.resolveReady?.(this.helloPayload);
                this.emit("hello", this.helloPayload);
                continue;
            }
            const jobId = evt.id as string | undefined;
            if (!jobId) continue;
            const job = this.pending.get(jobId);
            if (!job) continue;
            if (kind === "progress") {
                job.onProgress?.({
                    stage: String(evt.stage ?? ""),
                    pct: Number(evt.pct ?? 0),
                    msg: String(evt.msg ?? ""),
                });
            } else if (kind === "result") {
                clearTimeout(job.timer);
                this.pending.delete(jobId);
                if (evt.ok) {
                    job.resolve((evt.data as Record<string, unknown>) ?? {});
                } else {
                    job.reject(new Error(String(evt.error ?? `${this.opts.name}-job-failed`)));
                }
            }
        }
    }
}
