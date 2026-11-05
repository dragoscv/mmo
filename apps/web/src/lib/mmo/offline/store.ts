/** Tiny promise wrapper over IndexedDB `mixai-offline` (no `idb` dependency in apps/web). Browser-only. */
import { IDB_NAME, IDB_STORE, IDB_VERSION } from "./keys";
import type { OfflineItem } from "./types";

function done<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

/** Same upgrade as `public/offline/downloads.js` — keep in sync. */
export function upgrade(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(IDB_STORE)) {
        const s = db.createObjectStore(IDB_STORE, { keyPath: "key" });
        s.createIndex("scope", "scope");
    }
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(IDB_NAME, IDB_VERSION);
        r.onupgradeneeded = () => upgrade(r.result);
        r.onsuccess = () => {
            const db = r.result;
            // Sign-out deletes the database from the service worker: let go so the delete is not blocked.
            db.onversionchange = () => { db.close(); dbPromise = null; };
            db.onclose = () => { dbPromise = null; };
            resolve(db);
        };
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error("indexeddb blocked"));
    });
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    return p;
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await openDb();
    return db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
}

export async function getItem(key: string): Promise<OfflineItem | null> {
    const r = await done((await store("readonly")).get(key));
    return (r as OfflineItem | undefined) ?? null;
}

export async function putItem(item: OfflineItem): Promise<void> {
    await done((await store("readwrite")).put(item));
}

export async function deleteItem(key: string): Promise<void> {
    await done((await store("readwrite")).delete(key));
}

export async function listItems(scope?: string): Promise<OfflineItem[]> {
    const s = await store("readonly");
    const rows = scope ? await done(s.index("scope").getAll(scope)) : await done(s.getAll());
    return (rows as OfflineItem[]).sort((a, b) => b.addedAt - a.addedAt);
}
