/**
 * Folder watcher.
 *
 * Wraps `chokidar` with a per-folder lifecycle so the server can start /
 * stop watchers as the user toggles `watch` on each `FolderConfig`.
 *
 * For every `add` / `change` event we:
 *   1. Parse the file with the same metadata pipeline used by manual scans.
 *   2. Push a `WatchEvent` onto a per-watcher queue.
 *   3. Broadcast `{type:"watch:event", folder, kind, payload}` over WS.
 *
 * The web app polls `GET /watch/events?since=<ms>` (or, when present,
 * receives the WS push) and ingests the queued payloads through the
 * normal `/library/tracks/ingest` route. We DO NOT ingest server-side
 * because the companion does not own a userId — `/library/*` is per-user
 * via `X-User-Id`. Storing locally also lets the web app handle dedupe
 * + the `revalidatePath` cache invalidation in one place.
 *
 * Queue retention: events older than 1 hour are garbage-collected so the
 * memory footprint stays bounded even if the web app never reconnects.
 */

import chokidar, { type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { AUDIO_EXTENSIONS, parseSingleFile } from "./scan-runner";
import type { ScannedTrackPayload } from "./scan-jobs";

export interface WatchEvent {
    id: number;
    folder: string;
    kind: "add" | "change" | "unlink";
    filepath: string;
    /** Present for add/change. Null for unlink. */
    payload: ScannedTrackPayload | null;
    timestamp: number;
}

export interface WatcherStatus {
    folder: string;
    active: boolean;
    /** When the watcher first emitted its `ready` event. Null until then. */
    readyAt: number | null;
    eventsSeen: number;
    error: string | null;
}

const QUEUE_TTL_MS = 60 * 60_000;           // 1 hour
const QUEUE_HARD_CAP = 5_000;
let nextEventId = 1;

interface ManagedWatcher {
    folder: string;
    fsw: FSWatcher;
    status: WatcherStatus;
}

const watchers = new Map<string, ManagedWatcher>();
const eventQueue: WatchEvent[] = [];

/** Bus that consumers (e.g. server.ts) can subscribe to so they can
 *  broadcast events over WebSocket. */
export const watcherBus = new EventEmitter();

function pushEvent(ev: WatchEvent) {
    eventQueue.push(ev);
    if (eventQueue.length > QUEUE_HARD_CAP) eventQueue.splice(0, eventQueue.length - QUEUE_HARD_CAP);
    watcherBus.emit("event", ev);
}

function gcQueue() {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    while (eventQueue.length > 0 && eventQueue[0].timestamp < cutoff) eventQueue.shift();
}

let gcTimer: NodeJS.Timeout | null = null;
export function startWatcherGc() {
    if (gcTimer) return;
    gcTimer = setInterval(gcQueue, 60_000);
    if (typeof gcTimer.unref === "function") gcTimer.unref();
}
export function stopWatcherGc() {
    if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
}

export function startWatcher(folder: string): WatcherStatus {
    const existing = watchers.get(folder);
    if (existing) return existing.status;
    const status: WatcherStatus = {
        folder,
        active: true,
        readyAt: null,
        eventsSeen: 0,
        error: null,
    };
    // We rely on chokidar's awaitWriteFinish so we don't try to parse a
    // file mid-copy (which would frequently produce truncated metadata).
    const fsw = chokidar.watch(folder, {
        ignoreInitial: true,
        persistent: true,
        depth: 99,
        awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 150 },
    });
    const handle = (kind: "add" | "change") => async (filepath: string) => {
        const ext = filepath.toLowerCase().slice(filepath.lastIndexOf("."));
        if (!AUDIO_EXTENSIONS.has(ext)) return;
        const payload = await parseSingleFile(filepath);
        if (!payload) return;
        status.eventsSeen++;
        pushEvent({
            id: nextEventId++,
            folder,
            kind,
            filepath,
            payload,
            timestamp: Date.now(),
        });
    };
    fsw.on("add", handle("add"));
    fsw.on("change", handle("change"));
    fsw.on("unlink", (filepath: string) => {
        const ext = filepath.toLowerCase().slice(filepath.lastIndexOf("."));
        if (!AUDIO_EXTENSIONS.has(ext)) return;
        status.eventsSeen++;
        pushEvent({
            id: nextEventId++,
            folder,
            kind: "unlink",
            filepath,
            payload: null,
            timestamp: Date.now(),
        });
    });
    fsw.on("ready", () => { status.readyAt = Date.now(); });
    fsw.on("error", (err: unknown) => {
        status.error = err instanceof Error ? err.message : String(err);
    });
    watchers.set(folder, { folder, fsw, status });
    return status;
}

export async function stopWatcher(folder: string): Promise<void> {
    const w = watchers.get(folder);
    if (!w) return;
    watchers.delete(folder);
    w.status.active = false;
    try { await w.fsw.close(); } catch { /* ignore */ }
}

export function getWatcherStatus(folder: string): WatcherStatus | null {
    return watchers.get(folder)?.status ?? null;
}

export function listWatcherStatuses(): WatcherStatus[] {
    return Array.from(watchers.values()).map((w) => w.status);
}

/** Drain queued events newer than `since` (ms epoch). Returns the events
 *  in chronological order. The caller is expected to acknowledge by
 *  passing the highest seen id back as `since` next time. */
export function getEventsSince(since: number): WatchEvent[] {
    if (!since) return eventQueue.slice();
    return eventQueue.filter((e) => e.id > since);
}

export async function stopAllWatchers(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const w of watchers.values()) tasks.push(w.fsw.close().catch(() => { /* ignore */ }));
    watchers.clear();
    await Promise.all(tasks);
}
