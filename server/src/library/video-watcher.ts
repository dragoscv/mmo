/**
 * Chokidar-based video library watcher.
 *
 * Watches all configured scan folders for added/removed video files and
 * emits change events. Consumers (the web app via SSE, plus the
 * companion UI) can subscribe via `videoLibraryBus`.
 *
 * Debounced: bursty filesystem activity (e.g. a large transfer) coalesces
 * into a single `change` event with the aggregated list.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import type { FSWatcher } from "chokidar";
import { lazyEsm } from "../lib/esm-import";
import { getSettings } from "../store";
import { mediaLibraryHooks } from "../media/library-hooks";

// chokidar 5 is ESM-only; this build is CommonJS (see lib/esm-import).
const loadChokidar = lazyEsm<typeof import("chokidar")>("chokidar");

const VIDEO_EXT = new Set([".mp4", ".mkv", ".m4v", ".webm", ".mov", ".avi", ".wmv", ".flv", ".ts", ".m2ts"]);

const bus = new EventEmitter();
let watcher: FSWatcher | null = null;
let watchedRoots: string[] = [];
/** Generation counter so a stop/restart racing the async import wins. */
let generation = 0;

interface PendingChange {
    added: Set<string>;
    removed: Set<string>;
}
const pending: PendingChange = { added: new Set(), removed: new Set() };
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_DELAY = 1500;

function isVideo(p: string): boolean {
    return VIDEO_EXT.has(path.extname(p).toLowerCase());
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        if (pending.added.size === 0 && pending.removed.size === 0) return;
        const payload = {
            added: Array.from(pending.added),
            removed: Array.from(pending.removed),
            at: new Date().toISOString(),
        };
        pending.added.clear();
        pending.removed.clear();
        bus.emit("change", payload);
        // Incremental media library index (WP10-05).
        void mediaLibraryHooks().onFilesChanged(payload.added, payload.removed).catch((err: unknown) => bus.emit("error", err));
    }, FLUSH_DELAY);
}

export function startVideoWatcher(): void {
    const roots = getSettings().scanFolders.map((f) => f.path).filter(Boolean);
    if (roots.length === 0) {
        stopVideoWatcher();
        return;
    }
    // No-op if already watching the same roots
    if (watcher && roots.length === watchedRoots.length && roots.every((r, i) => r === watchedRoots[i])) return;

    stopVideoWatcher();
    watchedRoots = [...roots];
    const gen = ++generation;
    void loadChokidar().then((chokidar) => {
        // Stopped or restarted while the import was in flight.
        if (gen !== generation) return;
        const w = chokidar.watch(roots, {
            ignoreInitial: true,
            persistent: true,
            depth: 8,
            awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
            ignored: (p) => /[\\/](?:\.|node_modules|System Volume Information|\$Recycle\.Bin)/.test(p),
        });
        watcher = w;

        w.on("add", (p) => {
            if (!isVideo(p)) return;
            pending.added.add(p);
            pending.removed.delete(p);
            scheduleFlush();
        });
        w.on("unlink", (p) => {
            if (!isVideo(p)) return;
            pending.removed.add(p);
            pending.added.delete(p);
            scheduleFlush();
        });
        w.on("error", (err) => bus.emit("error", err));
    }, (err: unknown) => bus.emit("error", err));
}

export function stopVideoWatcher(): void {
    generation++;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pending.added.clear();
    pending.removed.clear();
    if (watcher) {
        void watcher.close();
        watcher = null;
    }
    watchedRoots = [];
}

export function videoLibraryBus(): EventEmitter {
    return bus;
}
