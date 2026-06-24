/**
 * Device-command queue helpers (companion side).
 * Ported from apps/web/src/lib/device-commands.ts — only the functions the
 * announce/WS path needs: claiming pending commands for dispatch and
 * recording results posted back by the companion.
 *
 * The web app keeps owning `enqueueDeviceCommand` (the requester half);
 * the gateway only drains/records. Both operate on the same table.
 */

import { and, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { deviceCommands } from "../db/schema.js";

export interface PendingCommand {
    id: string;
    kind: string;
    payload: unknown;
}

/**
 * Expire stale rows, then atomically claim up to 32 pending commands for a
 * device and mark them dispatched. Returns the claimed batch.
 */
export async function claimPendingCommands(deviceId: string): Promise<PendingCommand[]> {
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
 * Persist results posted back by the companion. Scopes every UPDATE to
 * (id, deviceId) so a device can never write another device's results.
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
