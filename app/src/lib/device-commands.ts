/**
 * Device-command queue helpers.
 *
 * Why this exists: Vercel functions cannot reach the user's home LAN
 * where the companion runs, and browsers can't cross mixed-content+PNA
 * to talk to http://192.168.x.x from https://muzicai.ro. So the
 * companion polls (via its existing announce heartbeat) for pending
 * commands; we wait here on the DB until the result row materialises.
 *
 * Keep the API tiny:
 *   - `enqueueDeviceCommand(deviceId, kind, payload, opts?)`
 *       Insert pending row, poll until status changes, return result.
 *   - `claimPendingCommands(deviceId)` / `recordCommandResults(deviceId, ...)`
 *       Used by the /api/devices/announce route.
 */

import "server-only";
import { db } from "@/db";
import { deviceCommands } from "@/db/schema";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

export interface EnqueueOptions {
    /** Hard cap on how long we wait for the companion to answer. */
    timeoutMs?: number;
    /** DB poll interval while waiting. */
    pollMs?: number;
}

export interface CommandResult<T = unknown> {
    ok: boolean;
    /** Populated when ok=true. */
    result?: T;
    /** Populated when ok=false. */
    error?: string;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_POLL = 250;

/**
 * Enqueue a command and wait for the companion to execute it. Returns
 * {ok:false,error} after `timeoutMs` if no result arrives (the row stays
 * in the queue with status='pending' and is reaped by the next call to
 * `expireStaleCommands`).
 */
export async function enqueueDeviceCommand<T = unknown>(
    deviceId: string,
    kind: string,
    payload: unknown = null,
    opts: EnqueueOptions = {},
): Promise<CommandResult<T>> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const pollMs = opts.pollMs ?? DEFAULT_POLL;

    const t0 = Date.now();
    const expiresAt = new Date(Date.now() + Math.max(timeoutMs + 30_000, 60_000));
    const [row] = await db.insert(deviceCommands).values({
        deviceId,
        kind,
        payload: payload as never,
        expiresAt,
    }).returning({ id: deviceCommands.id });

    if (!row?.id) return { ok: false, error: "Failed to enqueue command" };
    const enqueuedMs = Date.now() - t0;
    console.log(`[cmd] enqueue kind=${kind} id=${row.id} device=${deviceId} in ${enqueuedMs}ms`);

    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
        await sleep(pollMs);
        polls++;
        const [r] = await db
            .select({
                status: deviceCommands.status,
                result: deviceCommands.result,
                error: deviceCommands.error,
            })
            .from(deviceCommands)
            .where(eq(deviceCommands.id, row.id))
            .limit(1);
        if (!r) {
            console.warn(`[cmd] row vanished kind=${kind} id=${row.id} after ${Date.now() - t0}ms polls=${polls}`);
            return { ok: false, error: "Command row vanished" };
        }
        if (r.status === "done") {
            console.log(`[cmd] done  kind=${kind} id=${row.id} in ${Date.now() - t0}ms polls=${polls}`);
            return { ok: true, result: r.result as T };
        }
        if (r.status === "error") {
            console.warn(`[cmd] error kind=${kind} id=${row.id} in ${Date.now() - t0}ms polls=${polls} — ${r.error}`);
            return { ok: false, error: r.error ?? "Unknown companion error" };
        }
        if (r.status === "expired") {
            console.warn(`[cmd] expired kind=${kind} id=${row.id} in ${Date.now() - t0}ms polls=${polls}`);
            return { ok: false, error: "Command expired before companion picked it up" };
        }
    }
    console.warn(`[cmd] timeout kind=${kind} id=${row.id} in ${Date.now() - t0}ms polls=${polls}`);
    return { ok: false, error: "Companion did not respond in time (device offline?)" };
}

/**
 * Atomically move all pending rows for this device to 'dispatched' and
 * return them. The announce route calls this to hand the batch to the
 * companion in the same response.
 */
export async function claimPendingCommands(deviceId: string): Promise<Array<{
    id: string;
    kind: string;
    payload: unknown;
}>> {
    // Reap rows whose hard-deadline elapsed before we got to them.
    await db.update(deviceCommands)
        .set({ status: "expired", completedAt: new Date() })
        .where(and(
            eq(deviceCommands.deviceId, deviceId),
            or(eq(deviceCommands.status, "pending"), eq(deviceCommands.status, "dispatched"))!,
            lt(deviceCommands.expiresAt, new Date()),
        ));

    const rows = await db
        .select({
            id: deviceCommands.id,
            kind: deviceCommands.kind,
            payload: deviceCommands.payload,
        })
        .from(deviceCommands)
        .where(and(
            eq(deviceCommands.deviceId, deviceId),
            eq(deviceCommands.status, "pending"),
        ))
        .orderBy(deviceCommands.createdAt)
        .limit(32);

    if (rows.length === 0) return [];

    await db.update(deviceCommands)
        .set({ status: "dispatched", dispatchedAt: new Date() })
        .where(inArray(deviceCommands.id, rows.map((r) => r.id)));

    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload }));
}

export interface IncomingCommandResult {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

/**
 * Persist results posted back by the companion. Silently ignores ids
 * the companion doesn't own (rate-limit + tampering defence) by scoping
 * the UPDATE to (id, deviceId).
 */
export async function recordCommandResults(
    deviceId: string,
    results: IncomingCommandResult[],
): Promise<void> {
    if (!Array.isArray(results) || results.length === 0) return;
    const now = new Date();
    for (const r of results) {
        if (typeof r?.id !== "string") continue;
        await db.update(deviceCommands)
            .set({
                status: r.ok ? "done" : "error",
                result: r.ok ? ((r.result ?? null) as never) : null,
                error: r.ok ? null : String(r.error ?? "unknown"),
                completedAt: now,
            })
            .where(and(
                eq(deviceCommands.id, r.id),
                eq(deviceCommands.deviceId, deviceId),
            ));
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

// Periodic cleanup: anything older than 1 hour is gone for good.
export async function purgeOldCommands(): Promise<void> {
    await db.delete(deviceCommands).where(
        lt(deviceCommands.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
    );
}
