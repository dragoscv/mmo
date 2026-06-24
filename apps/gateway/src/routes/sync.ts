/**
 * Cloud sync protocol — Phase 2, now served by the gateway.
 *
 *   GET  /api/sync?cursor=<id>   → { changes, nextCursor, hasMore }
 *   POST /api/sync               → { ok, applied, skipped, errors }
 *
 * Ported from apps/web/src/app/api/sync/route.ts. The conflict logic
 * (applyChange / appendSyncLog, per-field LWW) is the SHARED implementation
 * in @mmo/db — identical to what the web route runs — so there is no drift.
 *
 * Differences from the web route:
 *  - Auth/rate-limit use the gateway's own helpers.
 *  - Free-tier subscription gate reads the `subscriptions` table directly
 *    (no Stripe API call needed for a read).
 *  - The /library facet cache lives in the Next app; the gateway can't call
 *    revalidateTag, so it fires a best-effort POST to the web app's
 *    revalidation hook when track metadata changed (eventual consistency).
 */

import type { Context } from "hono";
import { and, eq, gt, isNull, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { devices, subscriptions, syncLog } from "@mmo/db/schema";
import { applyChange, appendSyncLog, type SyncChange } from "@mmo/db";
import { findDeviceByToken } from "../lib/device-token.js";

const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

async function isProUser(userId: string): Promise<boolean> {
    const rows = await db.select({ plan: subscriptions.plan, status: subscriptions.status })
        .from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
    const row = rows[0];
    if (!row) return false;
    return row.plan !== "free" && PRO_STATUSES.has(row.status);
}

async function authDevice(c: Context) {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    return findDeviceByToken(token);
}

async function bustLibraryFacets(userId: string): Promise<void> {
    const hook = process.env.WEB_REVALIDATE_URL;
    const secret = process.env.WEB_REVALIDATE_SECRET;
    if (!hook || !secret) return;
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 3000);
        await fetch(hook, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-revalidate-secret": secret },
            body: JSON.stringify({ tag: "library-facets", userId }),
            signal: ac.signal,
        }).finally(() => clearTimeout(t));
    } catch { /* best-effort */ }
}

export async function handleSyncGet(c: Context) {
    const dev = await authDevice(c);
    if (!dev) return c.json({ error: "Unauthorized" }, 401);

    if (!(await isProUser(dev.userId))) {
        const cutoff = new Date(Date.now() - 10 * 60_000);
        const all = await db.select({ id: devices.id, lastSeenAt: devices.lastSeenAt })
            .from(devices).where(eq(devices.userId, dev.userId));
        const live = all.filter((d) => d.lastSeenAt && d.lastSeenAt > cutoff);
        if (live.length > 1 && !live.some((d) => d.id === dev.id)) {
            return c.json(
                { error: "Free tier allows 1 device sync. Upgrade to Pro for unlimited devices.", code: "PAYWALL" },
                402,
            );
        }
    }

    const cursor = Number(c.req.query("cursor") ?? "0") || 0;
    const limit = Math.min(Number(c.req.query("limit") ?? "500"), 5000);

    const rows = await db
        .select()
        .from(syncLog)
        .where(and(
            eq(syncLog.userId, dev.userId),
            gt(syncLog.id, cursor),
            or(isNull(syncLog.originDeviceId), ne(syncLog.originDeviceId, dev.id)),
        ))
        .orderBy(syncLog.id)
        .limit(limit);

    const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.id : cursor;
    await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, dev.id));
    return c.json({ changes: rows, nextCursor, hasMore: rows.length === limit });
}

export async function handleSyncPost(c: Context) {
    const dev = await authDevice(c);
    if (!dev) return c.json({ error: "Unauthorized" }, 401);

    const body = await c.req.json().catch(() => ({})) as { changes?: SyncChange[] };
    if (!Array.isArray(body.changes)) {
        return c.json({ error: "Invalid body" }, 400);
    }
    if (body.changes.length > 1000) {
        return c.json({ error: "too many changes per request (max 1000)" }, 413);
    }

    let applied = 0;
    let skipped = 0;
    let tracksTouched = false;
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
                if (change.entity === "tracks" || change.entity === "track_tags") tracksTouched = true;
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

    await db.update(devices)
        .set({ lastSeenAt: new Date(), status: "syncing" })
        .where(eq(devices.id, dev.id));

    if (tracksTouched) void bustLibraryFacets(dev.userId);

    return c.json({ ok: errors.length === 0, applied, skipped, errors });
}
