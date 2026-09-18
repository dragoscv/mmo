/**
 * One-time key migrations for the MuzicAI → MixAI rebrand.
 *
 * Both helpers are idempotent: they copy old → new only when the new key is
 * absent and the old one is present, then remove the old key. Any storage
 * failure (private mode, quota, disabled IndexedDB) is swallowed — losing a
 * cache is acceptable, crashing the app is not.
 */

import { get, set, del } from "idb-keyval";

/** Migrate a Web Storage key (defaults to localStorage; pass sessionStorage
 *  for session-scoped data). No-op on the server. */
export function migrateLegacyStorageKey(
    oldKey: string,
    newKey: string,
    storage?: Storage,
): void {
    if (typeof window === "undefined") return;
    try {
        const store = storage ?? window.localStorage;
        if (store.getItem(newKey) !== null) return;
        const legacy = store.getItem(oldKey);
        if (legacy === null) return;
        store.setItem(newKey, legacy);
        store.removeItem(oldKey);
    } catch {
        /* private mode / quota / storage disabled */
    }
}

/** Same contract for idb-keyval entries (IndexedDB). No-op on the server. */
export async function migrateLegacyIdbKey(oldKey: string, newKey: string): Promise<void> {
    if (typeof window === "undefined") return;
    try {
        if ((await get(newKey)) !== undefined) return;
        const legacy = await get(oldKey);
        if (legacy === undefined) return;
        await set(newKey, legacy);
        await del(oldKey);
    } catch {
        /* IndexedDB unavailable */
    }
}
