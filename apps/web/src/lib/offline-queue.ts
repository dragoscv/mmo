"use client";

/**
 * Offline write-through queue for project autosaves.
 *
 * Strategy:
 *   1. Every save attempt is first written to an IndexedDB queue
 *      (durable across reloads / browser crashes).
 *   2. We then try to drain the queue by POSTing to the server action.
 *   3. On success the entry is removed. On failure it stays queued and
 *      is retried on the next online tick or page load.
 *
 * The same store is also used as a *cache* of the last-saved snapshot
 * per (kind, externalId), so the app can boot offline.
 */

export type ProjectKindKey = "daw" | "editor" | "live" | "mixer" | "visualization";

export interface QueuedSave {
    id: string;
    kind: ProjectKindKey;
    externalId: string;
    name?: string;
    document: Record<string, unknown>;
    extras?: Record<string, unknown>;
    queuedAt: number;
    attempts: number;
}

const DB_NAME = "mmo-projects";
const DB_VERSION = 1;
const STORE_QUEUE = "queue";
const STORE_CACHE = "cache";

let _db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_QUEUE)) {
                db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
            }
            if (!db.objectStoreNames.contains(STORE_CACHE)) {
                db.createObjectStore(STORE_CACHE, { keyPath: "key" });
            }
        };
        req.onsuccess = () => { _db = req.result; resolve(req.result); };
        req.onerror = () => reject(req.error);
    });
}

function tx(storeName: string, mode: IDBTransactionMode) {
    return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

export async function enqueueSave(entry: Omit<QueuedSave, "id" | "queuedAt" | "attempts">): Promise<string> {
    const store = await tx(STORE_QUEUE, "readwrite");
    const id = `${entry.kind}:${entry.externalId}:${Date.now()}`;
    const full: QueuedSave = { ...entry, id, queuedAt: Date.now(), attempts: 0 };
    return new Promise<string>((resolve, reject) => {
        const req = store.put(full);
        req.onsuccess = () => resolve(id);
        req.onerror = () => reject(req.error);
    });
}

export async function listQueue(): Promise<QueuedSave[]> {
    const store = await tx(STORE_QUEUE, "readonly");
    return new Promise<QueuedSave[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve((req.result as QueuedSave[]) ?? []);
        req.onerror = () => reject(req.error);
    });
}

export async function removeFromQueue(id: string): Promise<void> {
    const store = await tx(STORE_QUEUE, "readwrite");
    await new Promise<void>((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

export async function bumpAttempt(id: string): Promise<void> {
    const store = await tx(STORE_QUEUE, "readwrite");
    await new Promise<void>((resolve, reject) => {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
            const row = getReq.result as QueuedSave | undefined;
            if (!row) { resolve(); return; }
            row.attempts = (row.attempts ?? 0) + 1;
            const putReq = store.put(row);
            putReq.onsuccess = () => resolve();
            putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
    });
}

// ─── Cache (last-known document per project) ─────────────────────────────

interface CacheRow {
    key: string;
    kind: ProjectKindKey;
    externalId: string;
    name: string;
    document: Record<string, unknown>;
    cachedAt: number;
}

const cacheKey = (kind: ProjectKindKey, externalId: string) => `${kind}:${externalId}`;

export async function cacheProject(
    kind: ProjectKindKey,
    externalId: string,
    name: string,
    document: Record<string, unknown>,
): Promise<void> {
    const store = await tx(STORE_CACHE, "readwrite");
    const row: CacheRow = {
        key: cacheKey(kind, externalId),
        kind,
        externalId,
        name,
        document,
        cachedAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
        const req = store.put(row);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

export async function readCachedProject(
    kind: ProjectKindKey,
    externalId: string,
): Promise<CacheRow | null> {
    const store = await tx(STORE_CACHE, "readonly");
    return new Promise<CacheRow | null>((resolve, reject) => {
        const req = store.get(cacheKey(kind, externalId));
        req.onsuccess = () => resolve((req.result as CacheRow | undefined) ?? null);
        req.onerror = () => reject(req.error);
    });
}

export async function listCachedProjects(kind: ProjectKindKey): Promise<CacheRow[]> {
    const store = await tx(STORE_CACHE, "readonly");
    return new Promise<CacheRow[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
            const all = (req.result as CacheRow[]) ?? [];
            resolve(all.filter((r) => r.kind === kind));
        };
        req.onerror = () => reject(req.error);
    });
}
