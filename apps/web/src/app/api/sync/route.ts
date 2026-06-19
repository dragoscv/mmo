/**
 * Cloud sync protocol — keeps the companion's local SQLite mirror in step
 * with cloud Postgres.
 *
 *  GET  /api/sync?cursor=<id>     → { changes: SyncEvent[], nextCursor }
 *  POST /api/sync                 → { ok, applied, skipped, errors }
 *
 * Auth: device token (`Authorization: Bearer <token>`) tied to a registered
 * `devices` row. The device's `userId` scopes every query.
 *
 * Conflict policy:
 *  - tracks      → per-field LWW (see lib/sync-apply.ts)
 *  - playlists   → row-level LWW by externalId
 *  - cuepoints   → row-level LWW by externalId
 *  - tags / pivots → idempotent set ops
 *
 * Free tier: 1 active device. Pro: unlimited.
 */

import { db } from "@/db";
import { devices, syncLog } from "@/db/schema";
import { getSubscription } from "@/lib/stripe";
import { applyChange, appendSyncLog, type SyncChange } from "@/lib/sync-apply";
import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireRate } from "@/lib/api-guard";
import { findDeviceByToken } from "@/lib/device-token";

export const runtime = "nodejs";

async function authDevice(req: Request) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    return findDeviceByToken(token);
}

export async function GET(req: Request) {
    const dev = await authDevice(req);
    if (!dev) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Free-tier guard: count this user's *recently active* devices. The
    // `status` column drifts to "online" / "syncing" forever because no
    // cron resets it on inactivity, so the previous `status !== "offline"`
    // check would lock a free user out as soon as they'd ever paired more
    // than one device, even if everything but the current one had been
    // unplugged for weeks. Use a 10-minute lastSeenAt window instead — any
    // companion alive in the last 10 min is genuinely connected (heartbeat
    // runs ~every 30 s, sync push refreshes it too).
    const sub = await getSubscription(dev.userId);
    if (!sub.isPro) {
        const cutoff = new Date(Date.now() - 10 * 60_000);
        const all = await db.query.devices.findMany({ where: eq(devices.userId, dev.userId) });
        const liveDevices = all.filter((d) => d.lastSeenAt && d.lastSeenAt > cutoff);
        if (liveDevices.length > 1 && !liveDevices.some((d) => d.id === dev.id)) {
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
        .where(and(
            eq(syncLog.userId, dev.userId),
            gt(syncLog.id, cursor),
            // Skip the device's own pushes (echo-pull avoidance). Cloud-side
            // writes (web app / server actions) leave originDeviceId NULL
            // and are intentionally returned to every device including the
            // originator (because there isn't one).
            or(
                isNull(syncLog.originDeviceId),
                ne(syncLog.originDeviceId, dev.id),
            ),
        ))
        .orderBy(syncLog.id)
        .limit(limit);

    const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : cursor;
    // Bump lastSeenAt so a read-only poll (no local changes pending) still
    // counts as a live device for the free-tier window.
    await db
        .update(devices)
        .set({ lastSeenAt: new Date() })
        .where(eq(devices.id, dev.id));
    return NextResponse.json({ changes: rows, nextCursor, hasMore: rows.length === limit });
}

interface PushBody {
    changes: SyncChange[];
}

export async function POST(req: Request) {
    const blocked = requireRate(req, { bucket: "sync-push", windowMs: 60_000, max: 60 });
    if (blocked) return blocked;
    const dev = await authDevice(req);
    if (!dev) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as PushBody;
    if (!Array.isArray(body.changes)) {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    // Per-request batch cap. Each change does sequential Postgres
    // round-trips inside applyChange; without a cap, a single 100k-entry
    // POST can monopolise a request handler for minutes and starve other
    // tenants on the same instance.
    if (body.changes.length > 1000) {
        return NextResponse.json({ error: "too many changes per request (max 1000)" }, { status: 413 });
    }

    let applied = 0;
    let skipped = 0;
    const errors: Array<{ entity: string; entityId: string; error: string }> = [];

    for (const change of body.changes) {
        if (!change?.entity || !change?.entityId || !change?.op || !change?.updatedAt) {
            errors.push({
                entity: String(change?.entity ?? "?"),
                entityId: String(change?.entityId ?? "?"),
                error: "Missing entity/entityId/op/updatedAt",
            });
            continue;
        }
        try {
            const res = await applyChange(dev.userId, change, dev.id);
            if (res.error) {
                errors.push({ entity: change.entity, entityId: change.entityId, error: res.error });
                continue;
            }
            if (res.changed) {
                applied++;
                await appendSyncLog(dev.userId, change, dev.id);
            } else if (res.skipped) {
                skipped++;
            }
        } catch (e) {
            errors.push({
                entity: change.entity,
                entityId: change.entityId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    await db
        .update(devices)
        .set({ lastSeenAt: new Date(), status: "syncing" })
        .where(eq(devices.id, dev.id));

    return NextResponse.json({ ok: errors.length === 0, applied, skipped, errors });
}
