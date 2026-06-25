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

const PRUNE_HARD_CAP = 50_000; // never delete more than this in one run

/**
 * Reconcile every online companion: prune cloud tracks whose file no longer
 * exists on the owning companion. Returns a per-device summary.
 */
export async function reconcileCloudWithCompanions(): Promise<{
    results: ReconcileResult[];
    totalPruned: number;
    error?: string;
}> {
    const session = await auth();
    if (!session?.user?.id) return { results: [], totalPruned: 0, error: "Not signed in" };
    const userId = session.user.id;

    const links = (await getAllCompanionLinks()).filter((l) => l.online);
    if (links.length === 0) {
        return { results: [], totalPruned: 0, error: "No online companion to reconcile against" };
    }

    const results: ReconcileResult[] = [];
    let totalPruned = 0;

    for (const link of links) {
        // 1. Collect the companion's current filepath set (paged).
        const have = new Set<string>();
        let page = 1;
        const PAGE = 500;
        let companionTotal = 0;
        let safe = true;
        try {
            while (true) {
                const res = await companionLibrary.getTracks(link, { page, pageSize: PAGE });
                companionTotal = res.total ?? companionTotal;
                for (const t of res.tracks) {
                    if (t.filepath) have.add(t.filepath);
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

        // 2. Read cloud tracks for this device.
        const cloudRows = await db
            .select({ id: tracks.id, filepath: tracks.filepath })
            .from(tracks)
            .where(and(eq(tracks.userId, userId), eq(tracks.deviceId, link.deviceId)));

        // 3. Prune cloud rows whose filepath is absent on the companion.
        const orphanIds = cloudRows
            .filter((r) => !r.filepath || !have.has(r.filepath))
            .map((r) => r.id);

        let pruned = 0;
        if (orphanIds.length > 0) {
            const toDelete = orphanIds.slice(0, PRUNE_HARD_CAP);
            // Delete in chunks to keep parameter counts sane.
            for (let i = 0; i < toDelete.length; i += 500) {
                const chunk = toDelete.slice(i, i + 500);
                const res = await db
                    .delete(tracks)
                    .where(and(eq(tracks.userId, userId), inArray(tracks.id, chunk)));
                pruned += res.count ?? chunk.length;
            }
        }

        totalPruned += pruned;
        results.push({
            deviceId: link.deviceId,
            name: link.name,
            companionTrackCount: companionTotal || have.size,
            cloudTrackCount: cloudRows.length,
            pruned,
        });
    }

    if (totalPruned > 0) {
        revalidatePath("/library");
        revalidatePath("/");
    }
    return { results, totalPruned };
}
