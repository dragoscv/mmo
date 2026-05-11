/**
 * CloudSync wiring.
 *
 * Constructs the singleton CloudSyncClient + SqliteSyncStorage pair on
 * first call, seeded with the device token + cloud URL from the
 * companion's persistent store. Returns null when the device hasn't
 * been paired yet (no deviceToken) — main.ts should retry after the
 * user signs in.
 *
 * Designed so the rest of the codebase can `enqueueSyncChange(...)`
 * without knowing whether the loop is currently running. Calls before
 * `startCloudSync()` are no-ops; calls afterwards land in the queue.
 */

import { store } from "../store";
import { getLibrarySqlite } from "../library/db";
import { log } from "../lib/logger";
import { CloudSyncClient, type SyncChange } from "./cloud-sync-client";
import { SqliteSyncStorage, bootstrapSyncTables, enqueueSyncChangeRaw } from "./sqlite-sync-storage";

let _client: CloudSyncClient | null = null;
let _storage: SqliteSyncStorage | null = null;
let _bootstrapped = false;
let _onApplied: ((entities: ReadonlySet<SyncChange["entity"]>) => void) | null = null;

/**
 * Bootstrap the sync tables on first use, before any enqueue or start
 * call. Safe to call repeatedly; uses `CREATE TABLE IF NOT EXISTS`. The
 * point of running this BEFORE `startCloudSync` is so that mutations
 * enqueued in the gap between app boot and cloud-sync start still land
 * durably in `sync_queue` instead of being silently dropped.
 */
function ensureBootstrapped(): void {
    if (_bootstrapped) return;
    bootstrapSyncTables(getLibrarySqlite());
    _bootstrapped = true;
}

function readSeed(): { apiUrl: string; deviceToken: string } | null {
    const apiUrl = (store.get("webAppUrl") as string | undefined) ?? "https://muzicai.ro";
    const deviceToken = (store.get("deviceToken") as string | undefined) ?? "";
    if (!deviceToken) return null;
    return { apiUrl, deviceToken };
}

export function startCloudSync(logger?: (msg: string, err?: unknown) => void): boolean {
    if (_client) return true;
    const seed = readSeed();
    if (!seed) {
        logger?.("[cloud-sync] not started — device not paired (no deviceToken in store)");
        return false;
    }
    ensureBootstrapped();
    _storage = new SqliteSyncStorage(getLibrarySqlite(), { seed, logger });
    _client = new CloudSyncClient(_storage);
    if (_onApplied) _client.onApplied = _onApplied;
    _client.start();
    logger?.(`[cloud-sync] started — apiUrl=${seed.apiUrl}`);
    return true;
}

/**
 * Register a listener fired once per pull tick that applied at least
 * one remote change. Used by the HTTP server to broadcast an
 * `invalidate` hint over the existing /ws fan-out so connected web
 * clients can refresh their queries without polling. Safe to call
 * before or after `startCloudSync()`.
 */
export function setOnAppliedListener(
    fn: (entities: ReadonlySet<SyncChange["entity"]>) => void,
): void {
    _onApplied = fn;
    if (_client) _client.onApplied = fn;
}

export function stopCloudSync(): void {
    _client?.stop();
    _client = null;
    _storage = null;
}

/**
 * Enqueue a local change for the next push tick. **Always durable** —
 * writes straight to the SQLite `sync_queue` table even if the cloud
 * sync loop hasn't started yet (e.g. fired during the boot window or
 * while the device is unpaired). Once `startCloudSync()` runs the
 * pending rows drain on the next tick.
 *
 * Failures here log and swallow — local DB writes are authoritative;
 * sync is best-effort and the route handler must not break because of
 * a queue insert error.
 */
export function enqueueSyncChange(change: SyncChange): void {
    try {
        ensureBootstrapped();
        enqueueSyncChangeRaw(getLibrarySqlite(), change);
    } catch (err) {
        log.warn("cloud-sync.enqueue failed", undefined, err);
    }
}

export function isCloudSyncRunning(): boolean {
    return _client !== null;
}
