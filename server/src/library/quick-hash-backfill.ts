/**
 * Backfill of the `tracks.quick_hash` column (docs/decks/crate-sync-design.md,
 * phase 1: "quick_hash at scan / ingest + backfill job").
 *
 * New tracks get their hash at scan / ingest. Tracks that were already in the
 * library before the column existed are filled here, in one pass: two short
 * reads per file (no decode). Safe to run repeatedly — it only touches rows
 * whose hash is still NULL.
 *
 * Deliberately narrow (`prepare/all/run`) so it can be driven by better-sqlite3
 * from the server or from a scratch script against a copy of the real library
 * without pulling in drizzle.
 */

import { quickHashOrNull } from "./quick-hash";

export interface BackfillStmt {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
}
export interface BackfillDb {
    prepare(sql: string): BackfillStmt;
}

export interface BackfillOptions {
    /** Restrict to one user; omitted = every user on this server. */
    userId?: string;
    /** Stop after this many rows (0 / undefined = all). */
    limit?: number;
    /** Injectable hasher for tests / alternate implementations. */
    hash?: (filepath: string) => string | null;
    /** Clock for the measured duration; injectable for tests. */
    now?: () => number;
}

export interface BackfillResult {
    scanned: number;
    updated: number;
    /** Rows whose file could not be read (moved, deleted, permissions). */
    failed: number;
    elapsedMs: number;
    /** Tracks still without a hash after this run. */
    remaining: number;
}

interface PendingRow { id: number; filepath: string }

/**
 * Named parameters on purpose: `?1` used twice is rejected by better-sqlite3
 * ("Too many parameter values were provided"), and `:userId` is needed in two
 * places. The same names are supplied to the count query below.
 */
const PENDING_SQL = `
        SELECT id, filepath FROM tracks
        WHERE (quick_hash IS NULL OR quick_hash = '')
            AND (:userId IS NULL OR user_id = :userId)
        ORDER BY id
        LIMIT :limit`;

const REMAINING_SQL = `
        SELECT COUNT(*) AS n FROM tracks
        WHERE (quick_hash IS NULL OR quick_hash = '')
            AND (:userId IS NULL OR user_id = :userId)`;

export function backfillQuickHashes(db: BackfillDb, opts: BackfillOptions = {}): BackfillResult {
    const hash = opts.hash ?? quickHashOrNull;
    const now = opts.now ?? Date.now;
    const started = now();
        const userId = opts.userId ?? null;
        const limit = opts.limit && opts.limit > 0 ? opts.limit : -1;

        const rows = db.prepare(PENDING_SQL).all({ userId, limit }) as PendingRow[];
    const update = db.prepare("UPDATE tracks SET quick_hash = ? WHERE id = ?");

    let updated = 0;
    let failed = 0;
    for (const row of rows) {
        const h = hash(row.filepath);
        if (!h) { failed++; continue; }
        update.run(h, row.id);
        updated++;
    }

        const remainingRow = db.prepare(REMAINING_SQL).all({ userId })[0] as { n: number } | undefined;

    return {
        scanned: rows.length,
        updated,
        failed,
        elapsedMs: now() - started,
        remaining: remainingRow?.n ?? 0,
    };
}
