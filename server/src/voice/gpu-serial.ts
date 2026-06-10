/**
 * GPU serialization gate.
 *
 * The companion runs multiple Python sidecars (ACE-Step, Demucs, RVC,
 * voice_clone) — each is a separate CUDA context. Without serialization
 * a single HTTP burst can pin a song generation (~6 GB) + a Demucs
 * separation (~4 GB) + an RVC convert (~1 GB) onto the same card at
 * the same time. On consumer cards (8–12 GB) that triggers a driver
 * hang / VRAM exhaustion BSOD on Windows.
 *
 * This module is a zero-dep `p-limit(1)` for the heavy GPU lanes: every
 * job is enqueued onto a single in-memory promise chain so at most one
 * is in flight per process. Light health/probe calls bypass it.
 *
 * Usage:
 *   import { gpuSerial } from "./gpu-serial";
 *   const result = await gpuSerial.run("ace-step:generate", () => engineRegistry.send(...));
 *
 * The label is purely diagnostic (shows up in the queue snapshot).
 */

import { log } from "../lib/logger";

interface QueueEntry {
    label: string;
    enqueuedAt: number;
}

class GpuSerial {
    private chain: Promise<unknown> = Promise.resolve();
    private queue: QueueEntry[] = [];
    private currentLabel: string | null = null;
    private currentStartedAt = 0;

    /** Enqueue `fn` so it runs after every previously-enqueued task settles.
     *  Always resolves/rejects with the wrapped function's outcome — a failure
     *  in one job does not break the chain for subsequent jobs. */
    run<T>(label: string, fn: () => Promise<T>): Promise<T> {
        const entry: QueueEntry = { label, enqueuedAt: Date.now() };
        this.queue.push(entry);
        const next = this.chain.then(async () => {
            this.queue.shift();
            this.currentLabel = label;
            this.currentStartedAt = Date.now();
            const waited = this.currentStartedAt - entry.enqueuedAt;
            if (waited > 250) {
                log.info("gpu.serial.wait", { label, waitedMs: waited, depth: this.queue.length });
            }
            try {
                return await fn();
            } finally {
                this.currentLabel = null;
                this.currentStartedAt = 0;
            }
        });
        // Swallow rejection on the chain itself so the next job still runs.
        this.chain = next.catch(() => undefined);
        return next as Promise<T>;
    }

    /** Snapshot for /diagnostics endpoints. */
    snapshot(): { current: { label: string; runningMs: number } | null; waiting: Array<{ label: string; waitingMs: number }> } {
        const now = Date.now();
        return {
            current: this.currentLabel
                ? { label: this.currentLabel, runningMs: now - this.currentStartedAt }
                : null,
            waiting: this.queue.map((q) => ({ label: q.label, waitingMs: now - q.enqueuedAt })),
        };
    }
}

export const gpuSerial = new GpuSerial();
