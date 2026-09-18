/**
 * Server-side watch progress (`PUT /media/progress`, WP12-02) on top of the
 * local `progress.ts` store, which stays as the offline fallback + queue.
 *
 *  - `reportProgress()` writes locally, then pushes at most every 10 s
 *    (`force` for pause/stop); failures land in `mixai-tv:progress-queue`.
 *  - `flushQueue()` retries the queue (called on Home mount and after a success).
 *  - `migrateLocalProgress()` moves the pre-WP12 `mixai-tv:progress` entries to
 *    the server once, mapping fileId → title via `GET /media/library`
 *    (flag `mixai-tv:progress-migrated:v1`).
 */
import type { MediaClient } from "./media";
import type { LibraryIndex, MediaKind, ProgressInput } from "./media-types";
import { allProgress, FINISHED_RATIO, setProgress } from "./progress";

export interface TitleRef {
    kind: MediaKind;
    tmdbId: number;
    season?: number;
    episode?: number;
}

export const QUEUE_KEY = "mixai-tv:progress-queue";
export const MIGRATED_FLAG = "mixai-tv:progress-migrated:v1";
export const PUSH_INTERVAL_MS = 10_000;
const QUEUE_MAX = 200;

const lastPush = new Map<string, number>();
let inFlight: Promise<void> | null = null;

function refKey(r: TitleRef): string {
    return `${r.kind}:${r.tmdbId}:${r.season ?? 0}:${r.episode ?? 0}`;
}

export function readQueue(): ProgressInput[] {
    try {
        const raw = localStorage.getItem(QUEUE_KEY);
        const j = raw ? (JSON.parse(raw) as unknown) : null;
        return Array.isArray(j) ? (j as ProgressInput[]) : [];
    } catch {
        return [];
    }
}

function writeQueue(q: ProgressInput[]): void {
    try {
        if (q.length === 0) localStorage.removeItem(QUEUE_KEY);
        else localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)));
    } catch { /* storage full/disabled */ }
}

/** Keep one (latest) entry per title in the queue. */
function enqueue(entry: ProgressInput): void {
    const k = refKey(entry);
    const q = readQueue().filter((e) => refKey(e) !== k);
    q.push(entry);
    writeQueue(q);
}

export function toInput(ref: TitleRef, positionSec: number, durationSec: number, completed?: boolean): ProgressInput {
    return {
        kind: ref.kind, tmdbId: ref.tmdbId, season: ref.season ?? 0, episode: ref.episode ?? 0,
        positionSec: Math.floor(positionSec), durationSec: Math.floor(durationSec > 0 ? durationSec : 0),
        completed, updatedAt: Date.now(),
    };
}

/** Push queued entries; resolves quietly, leaves the queue intact on failure. */
export function flushQueue(media: MediaClient): Promise<void> {
    if (inFlight) return inFlight;
    const q = readQueue();
    if (q.length === 0) return Promise.resolve();
    inFlight = media.putProgress(q)
        .then((r) => { if (r !== null) writeQueue([]); })
        .catch(() => undefined)
        .then(() => { inFlight = null; });
    return inFlight;
}

/**
 * Called from the Player on `timeupdate` / pause / stop. `fileId` keeps the
 * local resume store working when the title is unknown (old scan rows).
 */
export function reportProgress(
    media: MediaClient | null, fileId: string, ref: TitleRef | null,
    positionSec: number, durationSec: number, force = false,
): void {
    setProgress(fileId, positionSec, durationSec, force);
    if (!media || !ref || !Number.isFinite(positionSec) || positionSec < 0) return;
    const k = refKey(ref);
    const now = Date.now();
    if (!force && now - (lastPush.get(k) ?? 0) < PUSH_INTERVAL_MS) return;
    lastPush.set(k, now);
    const completed = durationSec > 0 && positionSec / durationSec >= FINISHED_RATIO ? true : undefined;
    enqueue(toInput(ref, positionSec, durationSec, completed));
    void flushQueue(media);
}

export function markWatched(media: MediaClient, ref: TitleRef, durationSec: number): Promise<{ revision: number } | null> {
    const dur = durationSec > 0 ? durationSec : 1;
    return media.putProgress([toInput(ref, dur, dur, true)]);
}

/** One-shot: local fileId-keyed resume data → server progress. */
export async function migrateLocalProgress(media: MediaClient): Promise<number> {
    try { if (localStorage.getItem(MIGRATED_FLAG)) return 0; } catch { return 0; }
    const local = allProgress();
    if (local.length === 0) { setFlag(); return 0; }
    let lib: LibraryIndex | null;
    try {
        lib = await fetchLibrary(media);
    } catch {
        return 0; // offline — retry next launch
    }
    if (lib === null) { setFlag(); return 0; } // old server: nothing to migrate to
    const byFile = new Map(lib.items.filter((i) => i.tmdbId !== null).map((i) => [i.serverFileId, i]));
    const inputs: ProgressInput[] = [];
    for (const p of local) {
        const row = byFile.get(p.fileId);
        if (!row || row.tmdbId === null) continue;
        inputs.push({
            kind: row.kind, tmdbId: row.tmdbId, season: row.season ?? 0, episode: row.episode ?? 0,
            positionSec: p.pos, durationSec: p.dur, updatedAt: p.at,
        });
    }
    if (inputs.length > 0) {
        try {
            await media.putProgress(inputs);
        } catch {
            return 0;
        }
    }
    setFlag();
    return inputs.length;
}

function setFlag(): void {
    try { localStorage.setItem(MIGRATED_FLAG, String(Date.now())); } catch { /* ignore */ }
}

async function fetchLibrary(media: MediaClient): Promise<LibraryIndex | null> {
    return media.mediaLibrary();
}
