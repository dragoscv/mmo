/**
 * Pure helpers for `actions/scan.ts`. Lives outside `actions/` because
 * the action file uses `"use server"`, which only allows async exports.
 */

export interface ScanLogLike {
    action: string;
    scannedAt: string | null;
}

/**
 * Bucket a list of scan-log entries into a per-day "tracks added"
 * series for the dashboard growth chart. Pre-seeds the last `days`
 * days at zero so the x-axis stays continuous when there's been no
 * recent activity. Counts only `action === "added"` entries.
 *
 * `now` is injectable so tests don't depend on the wall clock.
 */
export function bucketGrowth(
    logs: ScanLogLike[],
    days: number,
    now: Date = new Date(),
): Array<{ date: string; added: number }> {
    const buckets = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const entry of logs) {
        if (entry.action !== "added" || !entry.scannedAt) continue;
        const day = entry.scannedAt.slice(0, 10);
        if (!buckets.has(day)) continue;
        buckets.set(day, (buckets.get(day) ?? 0) + 1);
    }
    return Array.from(buckets.entries()).map(([date, added]) => ({ date, added }));
}
