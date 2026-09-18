/**
 * Push watch progress + track plays to the web app (`POST {webAppUrl}/api/media/sync`).
 *
 * - `schedule()` after every local write → one debounced push (10 s).
 * - `start()` also runs a full push every hour (safety net for missed deltas).
 * - Watermark `meta.last_pushed_revision`; only rows with `rev > watermark` go out.
 * - Auth: the same `Authorization: Bearer <deviceToken>` the cloud-sync client uses.
 * - 404 (endpoint not deployed yet) and network errors are non-fatal: the watermark
 *   is left alone and the next schedule/hourly tick retries. 401/403 pause pushes
 *   until the token changes (no point hammering).
 */

import type { MediaDb } from "./db";
import { getMeta, setMeta } from "./db";
import type { ProgressStore } from "./progress";
import type { MediaLogger, ProgressEntry, TrackPlay } from "./types";

export const PUSH_DEBOUNCE_MS = 10_000;
export const FULL_PUSH_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncPushBody {
    deviceId: string;
    revision: number;
    /** Watermark the delta starts after (0 for a full push). */
    since: number;
    full: boolean;
    progress: ProgressEntry[];
    plays: TrackPlay[];
}

export interface SyncResult {
    ok: boolean;
    status: number | "offline" | "skipped";
    pushed: number;
    revision: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
    Promise<{ ok: boolean; status: number }>;

export interface MediaSyncClientOptions {
    db: MediaDb;
    progress: ProgressStore;
    /** `https://mixai.ro`; undefined/empty → pushes are skipped. */
    getWebAppUrl: () => string | undefined;
    getDeviceToken: () => string | undefined;
    getDeviceId: () => string;
    log?: MediaLogger;
    fetch?: FetchLike;
    debounceMs?: number;
    fullIntervalMs?: number;
    now?: () => number;
}

export class MediaSyncClient {
    private timer: NodeJS.Timeout | null = null;
    private hourly: NodeJS.Timeout | null = null;
    private inFlight: Promise<SyncResult> | null = null;
    private pausedForToken: string | null = null;
    private lastErrorKey: string | null = null;
    private readonly fetchImpl: FetchLike;
    private readonly debounceMs: number;
    private readonly fullIntervalMs: number;
    /** Observable for tests / status. */
    lastResult: SyncResult | null = null;
    consecutiveFailures = 0;

    constructor(private readonly opts: MediaSyncClientOptions) {
        this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
        this.debounceMs = opts.debounceMs ?? PUSH_DEBOUNCE_MS;
        this.fullIntervalMs = opts.fullIntervalMs ?? FULL_PUSH_INTERVAL_MS;
    }

    getLastPushedRevision(): number {
        return Number(getMeta(this.opts.db, "last_pushed_revision") ?? "0");
    }

    /** Debounced push; many writes inside the window collapse into one request. */
    schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.push().catch(() => { /* logged inside */ });
        }, this.debounceMs);
        this.timer.unref?.();
    }

    start(): void {
        if (this.hourly) return;
        this.hourly = setInterval(() => { void this.push({ full: true }).catch(() => { /* logged */ }); }, this.fullIntervalMs);
        this.hourly.unref?.();
    }

    stop(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.hourly) { clearInterval(this.hourly); this.hourly = null; }
    }

    /** Push now. Serialised: a concurrent call awaits the in-flight one. */
    push(opts: { full?: boolean } = {}): Promise<SyncResult> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.pushOnce(opts.full === true).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    private async pushOnce(full: boolean): Promise<SyncResult> {
        const revision = this.opts.progress.getRevision();
        const base = this.opts.getWebAppUrl()?.replace(/\/+$/, "");
        const token = this.opts.getDeviceToken();
        const skip = (why: string): SyncResult => {
            this.opts.log?.debug(`[media/sync] skipped: ${why}`);
            return (this.lastResult = { ok: false, status: "skipped", pushed: 0, revision });
        };
        if (!base || !token) return skip("no webAppUrl/deviceToken");
        if (this.pausedForToken === token) return skip("paused after 401/403 (token unchanged)");

        const since = full ? 0 : this.getLastPushedRevision();
        if (!full && since >= revision) return skip("nothing new");
        const progress = this.opts.progress.progressSince(since);
        const plays = this.opts.progress.playsSince(since);
        if (!full && progress.length === 0 && plays.length === 0) {
            setMeta(this.opts.db, "last_pushed_revision", String(revision));
            return skip("delta empty (library-only revisions)");
        }
        const body: SyncPushBody = { deviceId: this.opts.getDeviceId(), revision, since, full, progress, plays };
        const pushed = progress.length + plays.length;

        let status: number;
        try {
            const res = await this.fetchImpl(`${base}/api/media/sync`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            status = res.status;
            if (res.ok) {
                setMeta(this.opts.db, "last_pushed_revision", String(revision));
                this.consecutiveFailures = 0;
                if (this.lastErrorKey) { this.opts.log?.info("[media/sync] recovered", { after: this.lastErrorKey }); this.lastErrorKey = null; }
                return (this.lastResult = { ok: true, status, pushed, revision });
            }
        } catch (err) {
            this.consecutiveFailures++;
            this.noteError("offline", err);
            return (this.lastResult = { ok: false, status: "offline", pushed: 0, revision });
        }

        this.consecutiveFailures++;
        if (status === 401 || status === 403) {
            this.pausedForToken = token;
            this.noteError(`http ${status} — paused until the device token changes`);
        } else if (status === 404) {
            this.noteError("http 404 — /api/media/sync not deployed yet");
        } else {
            this.noteError(`http ${status}`);
        }
        return (this.lastResult = { ok: false, status, pushed: 0, revision });
    }

    private noteError(key: string, err?: unknown): void {
        if (key === this.lastErrorKey) return; // dedupe repeats
        this.lastErrorKey = key;
        this.opts.log?.warn(`[media/sync] push failed: ${key}`, { failures: this.consecutiveFailures }, err);
    }
}
