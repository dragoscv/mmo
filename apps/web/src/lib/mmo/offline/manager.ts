/**
 * Offline download manager (WP16-42). Browser-only singleton (`offlineManager()`).
 *
 *  - Queue is persisted in IndexedDB (`store.ts`); bytes go to Cache Storage `mixai-offline-v1` in parts of
 *    `PART_SIZE` under synthetic `/__offline/<key>/p/<n>` URLs, plus `/m` (manifest, written last) — the SW
 *    stitches them with Range support. No server URL and no token is ever a cache key, and the persisted
 *    record holds the URL WITHOUT credentials (re-applied from the live connection: `setCreds`).
 *  - Sequential: one download at a time, progress from the response `ReadableStream`.
 *  - Pause/cancel abort the fetch. Resume continues at the last committed part with `Range: bytes=N-`
 *    when the server proved Range support (a 206), else restarts from 0. The file is stored as-is.
 *  - Quota: `navigator.storage.estimate()` before writing, `navigator.storage.persist()` on first enqueue.
 *  - Fetches use `cache: "no-store"` — the SW routes those cross-origin requests network-only so the
 *    `defaultCache` "cross-origin" runtime cache never keeps a tokenised multi-GB copy.
 */
import { Emitter } from "../emitter";
import {
    DOWNLOADS_ROUTE, OFFLINE_CACHE, SHELL_ASSETS, SHELL_CACHE, SHELL_DEPS, applyAuth, buildKey, entryPrefix, manifestUrl, partUrl,
    posterUrl, scopeOf, stripAuth, type ServerCreds,
} from "./keys";
import { PART_SIZE, quotaDecision, sum } from "./math";
import { deleteItem, getItem, listItems, putItem } from "./store";
import type { DownloadInput, OfflineChange, OfflineError, OfflineItem, OfflineManifest } from "./types";

/** localStorage: last scope seen on `/media/downloads`, read by the static offline shell. */
export const LAST_SCOPE_KEY = "mixai-offline:scope";

const PROGRESS_EMIT_MS = 250;
const PROGRESS_SAVE_MS = 2000;

class HttpError extends Error {
    constructor(readonly status: number) { super(`HTTP ${status}`); }
}
class QuotaError extends Error {
    constructor(readonly needed: number, readonly free: number) { super("quota"); }
}

function classify(e: unknown): OfflineError {
    if (e instanceof QuotaError) return { code: "quota", needed: e.needed, free: e.free };
    if (e instanceof HttpError) {
        if (e.status === 401 || e.status === 403) return { code: "auth", status: e.status };
        if (e.status === 404 || e.status === 410) return { code: "missing", status: e.status };
        return { code: "http", status: e.status };
    }
    if (e instanceof DOMException && e.name === "QuotaExceededError") return { code: "quota" };
    if (e instanceof TypeError) return { code: "network" };
    if (e instanceof DOMException) return { code: "storage" };
    return { code: "unknown" };
}

async function estimate(): Promise<{ usage: number | null; quota: number | null }> {
    try {
        const e = await navigator.storage?.estimate?.();
        return { usage: e?.usage ?? null, quota: e?.quota ?? null };
    } catch {
        return { usage: null, quota: null };
    }
}

export class OfflineManager {
    readonly changed = new Emitter<OfflineChange>();
    private readonly creds = new Map<string, ServerCreds>();
    /** Live progress of the active download (IDB is written less often). */
    private readonly live = new Map<string, number>();
    private active: { key: string; ctrl: AbortController; reason: "pause" | "cancel" | null } | null = null;
    private pumping = false;
    private persistAsked = false;
    private ready: Promise<void>;

    constructor() {
        this.ready = this.recover();
    }

    /** Credentials of a connected server (from `useMmo().clients.cfg`); kept in memory only. */
    setCreds(serverId: string, creds: ServerCreds): void {
        const prev = this.creds.get(serverId);
        this.creds.set(serverId, { token: creds.token, userId: creds.userId || prev?.userId || "" });
        if (!prev || prev.token !== creds.token) void this.pump();
    }

    async list(scope?: string): Promise<OfflineItem[]> {
        await this.ready;
        const items = await listItems(scope);
        return items.map((i) => this.withLive(i));
    }

    async get(key: string): Promise<OfflineItem | null> {
        await this.ready;
        const i = await getItem(key);
        return i ? this.withLive(i) : null;
    }

    /** Adds (or re-queues) a download. Returns the key. */
    async enqueue(input: DownloadInput): Promise<string> {
        await this.ready;
        const key = buildKey(input);
        void this.askPersist();
        void this.ensureShell();
        const existing = await getItem(key);
        const { url, auth, creds } = stripAuth(input.url);
        if (creds.token) this.creds.set(input.serverId, { token: creds.token, userId: creds.userId ?? this.creds.get(input.serverId)?.userId ?? "" });
        if (existing && existing.status === "done") return key;
        if (existing && (existing.status === "queued" || existing.status === "downloading")) return key;
        const now = Date.now();
        const item: OfflineItem = existing
            ? { ...existing, url, auth, status: "queued", error: null, updatedAt: now }
            : {
                key, scope: scopeOf(input.serverId, input.profileId), serverId: input.serverId, profileId: input.profileId,
                kind: input.kind, id: input.id, title: input.title, subtitle: input.subtitle ?? null,
                durationSec: input.durationSec ?? null, url, auth, hasPoster: false, size: null, bytes: 0, parts: [],
                mime: null, acceptRanges: false, status: "queued", error: null, addedAt: now, updatedAt: now, completedAt: null,
            };
        await this.save(item);
        if (input.poster && !item.hasPoster) void this.storePoster(key, input.poster);
        void this.pump();
        return key;
    }

    async pause(key: string): Promise<void> {
        if (this.active?.key === key) { this.active.reason = "pause"; this.active.ctrl.abort(); return; }
        const i = await getItem(key);
        if (i && i.status === "queued") await this.save({ ...i, status: "paused", updatedAt: Date.now() });
    }

    async resume(key: string): Promise<void> {
        const i = await getItem(key);
        if (!i || i.status === "done" || i.status === "downloading" || i.status === "queued") return;
        await this.save({ ...i, status: "queued", error: null, updatedAt: Date.now() });
        void this.pump();
    }

    /** Cancel + delete bytes and record. */
    async remove(key: string): Promise<void> {
        if (this.active?.key === key) { this.active.reason = "cancel"; this.active.ctrl.abort(); }
        await this.dropBytes(key, true);
        await deleteItem(key);
        this.live.delete(key);
        this.changed.emit({ key, item: null });
    }

    async removeAll(scope: string): Promise<void> {
        for (const i of await listItems(scope)) await this.remove(i.key);
    }

    /** Bytes used by this origin and the quota (for the storage meter). */
    estimate(): Promise<{ usage: number | null; quota: number | null }> { return estimate(); }

    /** Pre-caches the static offline shell (`public/offline/*` + its CSS/theme script). Best-effort. */
    async ensureShell(): Promise<void> {
        try {
            const c = await caches.open(SHELL_CACHE);
            await Promise.all([...SHELL_ASSETS, ...SHELL_DEPS].map(async (u) => {
                const res = await fetch(u, { cache: "no-cache" });
                if (res.ok) await c.put(u, res);
            }));
        } catch { /* offline or storage disabled — the next visit retries */ }
    }

    rememberScope(scope: string): void {
        try { localStorage.setItem(LAST_SCOPE_KEY, scope); } catch { /* storage disabled */ }
    }

    // ─── internals ─────────────────────────────────────────────────────────

    private withLive(i: OfflineItem): OfflineItem {
        const b = this.live.get(i.key);
        return b !== undefined && i.status === "downloading" ? { ...i, bytes: b } : i;
    }

    private async save(item: OfflineItem): Promise<void> {
        await putItem(item);
        this.changed.emit({ key: item.key, item: this.withLive(item) });
    }

    /** After a reload nothing is in flight: interrupted downloads go back to the queue; lost bytes → error. */
    private async recover(): Promise<void> {
        let items: OfflineItem[];
        try { items = await listItems(); } catch { return; }
        let cache: Cache | null = null;
        try { cache = await caches.open(OFFLINE_CACHE); } catch { /* no Cache Storage */ }
        for (const i of items) {
            if (i.status === "downloading") await putItem({ ...i, status: "queued", updatedAt: Date.now() });
            else if (i.status === "done" && cache && !(await cache.match(manifestUrl(i.key)))) {
                // Caches were purged (sign-out wipes them) but the record survived.
                await putItem({ ...i, status: "error", error: { code: "missing" }, bytes: 0, parts: [], updatedAt: Date.now() });
            }
        }
    }

    private async askPersist(): Promise<void> {
        if (this.persistAsked) return;
        this.persistAsked = true;
        try {
            if (navigator.storage?.persisted && (await navigator.storage.persisted())) return;
            await navigator.storage?.persist?.();
        } catch { /* not supported */ }
    }

    private async storePoster(key: string, url: string): Promise<void> {
        try {
            const res = await fetch(url, { cache: "no-store", mode: "cors", credentials: "omit" });
            if (!res.ok) return;
            const blob = await res.blob();
            const c = await caches.open(OFFLINE_CACHE);
            await c.put(posterUrl(key), new Response(blob, { headers: { "Content-Type": blob.type || "image/jpeg" } }));
            const i = await getItem(key);
            if (i) await this.save({ ...i, hasPoster: true });
        } catch { /* poster is optional (CORS, offline) */ }
    }

    private async dropBytes(key: string, withPoster: boolean): Promise<void> {
        try {
            const c = await caches.open(OFFLINE_CACHE);
            const prefix = entryPrefix(key);
            const reqs = await c.keys();
            await Promise.all(reqs
                .filter((r) => {
                    const p = new URL(r.url).pathname;
                    return p.startsWith(prefix) && (withPoster || !p.endsWith("/poster"));
                })
                .map((r) => c.delete(r)));
        } catch { /* nothing stored */ }
    }

    private async pump(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;
        try {
            await this.ready;
            for (;;) {
                const next = (await listItems())
                    .filter((i) => i.status === "queued" && (i.auth.length === 0 || this.creds.has(i.serverId)))
                    .sort((a, b) => a.updatedAt - b.updatedAt)[0];
                if (!next) break;
                await this.run(next);
            }
        } finally {
            this.pumping = false;
        }
    }

    private async run(start: OfflineItem): Promise<void> {
        const ctrl = new AbortController();
        const active = { key: start.key, ctrl, reason: null as "pause" | "cancel" | null };
        this.active = active;
        let item: OfflineItem = { ...start, status: "downloading", error: null, updatedAt: Date.now() };
        await this.save(item);
        try {
            item = await this.download(item, ctrl.signal);
            const manifest: OfflineManifest = { size: item.size ?? sum(item.parts), parts: item.parts, type: item.mime ?? "application/octet-stream" };
            const c = await caches.open(OFFLINE_CACHE);
            await c.put(manifestUrl(item.key), new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }));
            this.live.delete(item.key);
            await this.save({ ...item, status: "done", bytes: manifest.size, size: manifest.size, completedAt: Date.now(), updatedAt: Date.now() });
        } catch (e) {
            this.live.delete(item.key);
            if (active.reason === "cancel") {
                // A progress write may have landed after `remove()` deleted the record.
                await this.dropBytes(item.key, true);
                await deleteItem(item.key);
                return;
            }
            // `download()` persisted every committed part — the IDB copy is the truth.
            const fresh = (await getItem(item.key)) ?? item;
            const committed = { ...fresh, bytes: sum(fresh.parts) };
            if (active.reason === "pause" || ctrl.signal.aborted) await this.save({ ...committed, status: "paused", updatedAt: Date.now() });
            else await this.save({ ...committed, status: "error", error: classify(e), updatedAt: Date.now() });
        } finally {
            if (this.active === active) this.active = null;
        }
    }

    private async download(item: OfflineItem, signal: AbortSignal): Promise<OfflineItem> {
        const creds = this.creds.get(item.serverId);
        const url = creds ? applyAuth(item.url, item.auth, creds) : item.url;
        let parts = [...item.parts];
        let offset = sum(parts);
        if (offset > 0 && !item.acceptRanges) {
            await this.dropBytes(item.key, false);
            parts = [];
            offset = 0;
        }
        // `bytes=0-` on the first request too: a 206 proves Range support (Accept-Ranges isn't CORS-exposed).
        const res = await fetch(url, { signal, cache: "no-store", credentials: "omit", headers: { Range: `bytes=${offset}-` } });
        if (res.status === 416 && offset > 0 && item.size === offset) {
            return { ...item, parts, bytes: offset };
        }
        if (!res.ok) throw new HttpError(res.status);
        const acceptRanges = res.status === 206;
        if (!acceptRanges && offset > 0) {
            // Server ignored the Range: start over.
            await this.dropBytes(item.key, false);
            parts = [];
            offset = 0;
        }
        const len = Number(res.headers.get("Content-Length") ?? "");
        const size = Number.isFinite(len) && len > 0 ? offset + len : item.size;
        const mime = (res.headers.get("Content-Type") ?? "").split(";")[0]?.trim() || item.mime;
        // Subsonic reports errors as a 200 JSON/XML body — never store that as the media file.
        if (mime && /^(application\/(json|xml)|text\/(xml|html|plain))/.test(mime)) { void res.body?.cancel(); throw new HttpError(404); }
        const est = await estimate();
        const q = quotaDecision({ usage: est.usage, quota: est.quota, needed: size !== null ? size - offset : null });
        if (!q.ok) { void res.body?.cancel(); throw new QuotaError(q.needed, q.free); }

        let cur: OfflineItem = { ...item, parts, size, mime, acceptRanges, bytes: offset };
        await putItem(cur);
        const body = res.body;
        if (!body) throw new TypeError("empty body");
        const reader = body.getReader();
        const cache = await caches.open(OFFLINE_CACHE);
        let buf: Uint8Array[] = [];
        let bufLen = 0;
        let received = offset;
        let lastEmit = 0;
        let lastSave = Date.now();

        const flush = async (): Promise<void> => {
            if (bufLen === 0) return;
            const blob = new Blob(buf as BlobPart[], { type: mime ?? "application/octet-stream" });
            await cache.put(partUrl(item.key, parts.length), new Response(blob, { headers: { "Content-Type": blob.type } }));
            parts = [...parts, bufLen];
            buf = [];
            bufLen = 0;
            cur = { ...cur, parts, bytes: sum(parts) };
            await putItem({ ...cur, status: "downloading", updatedAt: Date.now() });
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            buf.push(value);
            bufLen += value.byteLength;
            received += value.byteLength;
            this.live.set(item.key, received);
            if (bufLen >= PART_SIZE) await flush();
            const now = Date.now();
            if (now - lastSave >= PROGRESS_SAVE_MS) {
                lastSave = now;
                await putItem({ ...cur, status: "downloading", updatedAt: now });
            }
            if (now - lastEmit >= PROGRESS_EMIT_MS) {
                lastEmit = now;
                this.changed.emit({ key: item.key, item: { ...cur, status: "downloading", bytes: received } });
            }
        }
        await flush();
        const total = sum(parts);
        if (size !== null && total !== size) throw new TypeError(`short read ${total}/${size}`);
        return { ...cur, size: total, bytes: total };
    }
}

let instance: OfflineManager | null = null;

/** The page-wide manager (null during SSR / without IndexedDB + Cache Storage). */
export function offlineManager(): OfflineManager | null {
    if (typeof window === "undefined" || typeof indexedDB === "undefined" || typeof caches === "undefined") return null;
    instance ??= new OfflineManager();
    return instance;
}

export { DOWNLOADS_ROUTE };
