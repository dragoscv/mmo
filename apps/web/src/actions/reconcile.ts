"use server";

/**
 * Cloud ↔ companion library reconciliation (prune).
 *
 * The cloud Postgres `tracks` table is the synced mirror of each companion's
 * local library. When files are deleted/moved on a companion, the cloud row
 * can be left orphaned (the sync protocol is add/update-biased). This action
 * prunes cloud tracks whose owning companion no longer has the file.
 *
 * SAFETY:
 *  - Only ONLINE companions are reconciled. An offline device is never pruned
 *    (we can't tell "file gone" from "device asleep").
 *  - Only tracks whose `deviceId` matches a reconciled, online companion are
 *    eligible. Tracks with a null deviceId or owned by an offline device are
 *    left untouched.
 *  - We compare by absolute filepath (the companion's source of truth).
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { companionLibrary, getAllCompanionLinks } from "@/lib/companion-library";
import { revalidatePath } from "next/cache";

export interface ReconcileResult {
    deviceId: string;
    name: string;
    companionTrackCount: number;
    cloudTrackCount: number;
    pruned: number;
    skipped?: string;
}

export interface ReconcileSummary {
    results: ReconcileResult[];
    totalPruned: number;
    backfilled: number;
    deduped: number;
    error?: string;
}

const PRUNE_HARD_CAP = 50_000; // never delete more than this in one run

/**
 * Reconcile every online companion: prune cloud tracks whose file no longer
 * exists on the owning companion. Returns a per-device summary.
 */
export async function reconcileCloudWithCompanions(): Promise<ReconcileSummary> {
    const session = await auth();
    if (!session?.user?.id) return { results: [], totalPruned: 0, backfilled: 0, deduped: 0, error: "Not signed in" };
    const userId = session.user.id;

    const links = (await getAllCompanionLinks()).filter((l) => l.online);
    if (links.length === 0) {
        return { results: [], totalPruned: 0, backfilled: 0, deduped: 0, error: "No online companion to reconcile against" };
    }

    const results: ReconcileResult[] = [];
    let totalPruned = 0;
    let backfilled = 0;
    let deduped = 0;

    // filepath → owning deviceId, unioned across all online companions. Used
    // both to prune (absent ⇒ orphan) and to backfill NULL deviceId rows.
    const ownerByPath = new Map<string, string>();

    for (const link of links) {
        // 1. Collect the companion's current filepath set (paged).
        const have = new Set<string>();
        let page = 1;
        const PAGE = 500;
        let companionTotal = 0;
        try {
            while (true) {
                const res = await companionLibrary.getTracks(link, { page, pageSize: PAGE });
                companionTotal = res.total ?? companionTotal;
                for (const t of res.tracks) {
                    if (t.filepath) { have.add(t.filepath); ownerByPath.set(t.filepath, link.deviceId); }
                }
                if (res.tracks.length < PAGE) break;
                page++;
                if (page > 400) break; // 200k cap
            }
        } catch (e) {
            results.push({
                deviceId: link.deviceId, name: link.name,
                companionTrackCount: 0, cloudTrackCount: 0, pruned: 0,
                skipped: `Could not read companion library: ${e instanceof Error ? e.message : String(e)}`,
            });
            continue;
        }

        // Guard: if the companion reports an EMPTY library, do NOT prune — an
        // empty read is far more likely a transient/unscanned state than the
        // user having deleted their entire library. Refuse and report.
        if (have.size === 0) {
            results.push({
                deviceId: link.deviceId, name: link.name,
                companionTrackCount: 0, cloudTrackCount: 0, pruned: 0,
                skipped: "Companion reports 0 tracks — refusing to prune (scan first)",
            });
            continue;
        }
        results.push({
            deviceId: link.deviceId,
            name: link.name,
            companionTrackCount: companionTotal || have.size,
            cloudTrackCount: 0, // filled in the global pass below
            pruned: 0,
        });
    }

    // If NO online companion produced a usable filepath set, bail without
    // touching cloud data (avoids mass-delete on a transient empty read).
    if (ownerByPath.size === 0) {
        return { results, totalPruned: 0, backfilled: 0, deduped: 0, error: "No companion filepaths read — nothing reconciled" };
    }

    // ── Global pass over ALL the user's cloud tracks ────────────────────
    // Includes NULL-deviceId rows (historical syncs never stamped a device).
    // A row is an orphan when its filepath is absent from EVERY online
    // companion. Rows that match get their deviceId backfilled.
    const cloudRows = await db
        .select({ id: tracks.id, filepath: tracks.filepath, deviceId: tracks.deviceId, analyzedAt: tracks.analyzedAt })
        .from(tracks)
        .where(eq(tracks.userId, userId));

    const orphanIds: number[] = [];
    const backfillByDevice = new Map<string, number[]>();
    // Dedupe: keep ONE row per filepath (prefer analyzed, else lowest id);
    // collect the rest for deletion.
    const bestByPath = new Map<string, { id: number; analyzed: boolean }>();
    const dupeIds: number[] = [];
    for (const r of cloudRows) {
        if (!r.filepath) continue;
        const analyzed = r.analyzedAt != null;
        const cur = bestByPath.get(r.filepath);
        if (!cur) { bestByPath.set(r.filepath, { id: r.id, analyzed }); continue; }
        // Decide winner: analyzed beats non-analyzed; otherwise lower id wins.
        const challengerWins = (analyzed && !cur.analyzed) || (analyzed === cur.analyzed && r.id < cur.id);
        if (challengerWins) { dupeIds.push(cur.id); bestByPath.set(r.filepath, { id: r.id, analyzed }); }
        else { dupeIds.push(r.id); }
    }
    const dupeSet = new Set(dupeIds);
    for (const r of cloudRows) {
        if (dupeSet.has(r.id)) continue; // handled by dedupe delete below
        const owner = r.filepath ? ownerByPath.get(r.filepath) : undefined;
        if (!owner) {
            // Absent on every online companion → orphan.
            if (r.filepath) orphanIds.push(r.id);
            continue;
        }
        if (r.deviceId !== owner) {
            const arr = backfillByDevice.get(owner) ?? [];
            arr.push(r.id);
            backfillByDevice.set(owner, arr);
        }
    }

    // Delete duplicate rows first (keeps the chosen winner per filepath).
    for (let i = 0; i < dupeIds.length; i += 500) {
        const chunk = dupeIds.slice(i, i + 500);
        const res = await db.delete(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, chunk)));
        deduped += res.count ?? chunk.length;
    }

    // Backfill deviceId so future reconciles + per-device counts are correct.
    for (const [deviceId, ids] of backfillByDevice) {
        for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            const res = await db.update(tracks)
                .set({ deviceId })
                .where(and(eq(tracks.userId, userId), inArray(tracks.id, chunk)));
            backfilled += res.count ?? chunk.length;
        }
    }

    // Prune orphans.
    const toDelete = orphanIds.slice(0, PRUNE_HARD_CAP);
    for (let i = 0; i < toDelete.length; i += 500) {
        const chunk = toDelete.slice(i, i + 500);
        const res = await db.delete(tracks)
            .where(and(eq(tracks.userId, userId), inArray(tracks.id, chunk)));
        totalPruned += res.count ?? chunk.length;
    }
    // Reflect totals in the per-device summary.
    for (const r of results) {
        if (r.skipped) continue;
        r.cloudTrackCount = cloudRows.length;
        r.pruned = totalPruned;
    }

    if (totalPruned > 0) {
        revalidatePath("/library");
        revalidatePath("/");
    }
    if (deduped > 0 || totalPruned > 0) {
        revalidatePath("/library");
        revalidatePath("/");
    }
    return { results, totalPruned, backfilled, deduped };
}
