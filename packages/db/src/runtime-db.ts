/**
 * Injectable Drizzle client for shared data-plane logic (sync-apply).
 *
 * `packages/db` deliberately does NOT own a DB connection — each consumer
 * has its own pool strategy (serverless 1-conn for apps/web on Vercel, a
 * small persistent pool for apps/gateway on Cloud Run). Consumers call
 * `setDb(db)` once at startup; the shared logic reads it via `getDb()`.
 */

// Loosely typed to avoid coupling the shared package to a specific Drizzle
// client generic. Callers pass their fully-typed drizzle() instance.
type AnyDb = {
    select: (...a: never[]) => unknown;
    insert: (...a: never[]) => unknown;
    update: (...a: never[]) => unknown;
    delete: (...a: never[]) => unknown;
    [k: string]: unknown;
};

let _db: AnyDb | null = null;

export function setDb(db: unknown): void {
    _db = db as AnyDb;
}

export function getDb<T = AnyDb>(): T {
    if (!_db) {
        throw new Error(
            "@mmo/db: getDb() called before setDb(). Call setDb(drizzleInstance) at startup.",
        );
    }
    return _db as T;
}
