/**
 * Cloud sync protocol — used by the companion app to keep its local SQLite in
 * step with cloud Postgres.
 *
 *  GET  /api/sync/pull?cursor=<id>   → { changes: SyncEvent[], nextCursor }
 *  POST /api/sync/push               → { ok: true, applied: number }
 *
 * Auth: device token (sent as `Authorization: Bearer <token>`) tied to a
 * registered `devices` row. The device's `userId` scopes ALL queries.
 *
 * Conflict policy: last-write-wins by `updated_at`. Both sides bump
 * `updated_at` on every write; on collision the side with the newer
 * timestamp keeps its value.
 *
 * Free tier: 1 active device. Pro: unlimited.
 */

import { db } from "@/db";
import { devices, syncLog } from "@/db/schema";
import { getSubscription } from "@/lib/stripe";
import { and, eq, gt } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

async function authDevice(req: Request) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    const dev = await db.query.devices.findFirst({ where: eq(devices.token, token) });
    return dev ?? null;
}

export async function GET(req: Request) {
    const dev = await authDevice(req);
    if (!dev) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Free-tier guard: count this user's active devices.
    const sub = await getSubscription(dev.userId);
    if (!sub.isPro) {
        const all = await db.query.devices.findMany({ where: eq(devices.userId, dev.userId) });
        const onlineDevices = all.filter((d) => d.status !== "offline");
        if (onlineDevices.length > 1 && !onlineDevices.some((d) => d.id === dev.id)) {
            return NextResponse.json(
                { error: "Free tier allows 1 device sync. Upgrade to Pro for unlimited devices.", code: "PAYWALL" },
                { status: 402 },
            );
        }
    }

    const url = new URL(req.url);
    const cursor = Number(url.searchParams.get("cursor") ?? "0") || 0;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "500"), 5000);

    const rows = await db
        .select()
        .from(syncLog)
        .where(and(eq(syncLog.userId, dev.userId), gt(syncLog.id, cursor)))
        .orderBy(syncLog.id)
        .limit(limit);

    const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : cursor;
    return NextResponse.json({ changes: rows, nextCursor, hasMore: rows.length === limit });
}

type PushBody = {
    changes: Array<{
        entity: string;
        entityId: string;
        op: "upsert" | "delete";
        payload: unknown;
        updatedAt: string;
    }>;
};

export async function POST(req: Request) {
    const dev = await authDevice(req);
    if (!dev) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as PushBody;
    if (!Array.isArray(body.changes)) {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    // TODO: per-entity dispatch with last-write-wins. For now we just log the
    // intent so the protocol is testable; the actual table updates land in a
    // follow-up that mirrors the companion's SQL writers.
    let applied = 0;
    for (const change of body.changes) {
        await db.insert(syncLog).values({
            userId: dev.userId,
            entity: change.entity,
            entityId: change.entityId,
            op: change.op,
            payload: change.payload as object | null,
        });
        applied++;
    }

    // Update device heartbeat + cursor.
    await db
        .update(devices)
        .set({ lastSeenAt: new Date(), status: "syncing" })
        .where(eq(devices.id, dev.id));

    return NextResponse.json({ ok: true, applied });
}
