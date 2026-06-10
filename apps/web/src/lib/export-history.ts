/**
 * Per-playlist USB export snapshots, stored in `localStorage`.
 *
 * Records the set of track ids the user last exported for each
 * (playlistId, format) pair, so the next export can diff against it
 * and show "+12 added, -3 removed since last export". This intentionally
 * does NOT round-trip through the database:
 *
 *  1. Exports are inherently per-device (you only care what was on
 *     *this* USB stick last time, not what some other device wrote).
 *  2. Avoiding a new migration keeps the batch contained.
 *  3. localStorage is per-origin, which is the right scope (a hosted
 *     deployment and a self-hosted one are different exports).
 *
 * The data lives under one key per format. Within each key:
 *   {
 *     "<playlistId>": { trackIds: number[]; exportedAt: string },
 *     ...
 *   }
 *
 * The set is capped at 100 playlists (newest wins). Over the cap is
 * extremely unlikely in practice (most users have < 30 playlists) but
 * the cap stops a runaway loop from pushing localStorage over its
 * ~5 MB quota.
 */

const isBrowser = typeof window !== "undefined";

export type ExportFormat = "xml" | "crate" | "audio";

export interface ExportSnapshot {
    /** Track ids in the order they were exported (order is preserved for stable diffs). */
    trackIds: number[];
    /** ISO timestamp of when this export happened. */
    exportedAt: string;
}

export interface ExportDiff {
    added: number[];
    removed: number[];
    unchanged: number[];
    /** Whether there is a previous snapshot at all. */
    hasPrevious: boolean;
    /** Previous snapshot's exportedAt, if any. */
    previousAt: string | null;
}

const MAX_PLAYLISTS_TRACKED = 100;

function storageKey(format: ExportFormat): string {
    return `mmo:export-history:${format}`;
}

type SnapshotMap = Record<string, ExportSnapshot>;

function readMap(format: ExportFormat): SnapshotMap {
    if (!isBrowser) return {};
    try {
        const raw = window.localStorage.getItem(storageKey(format));
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        // Filter out malformed entries rather than throwing — corrupted
        // localStorage on one entry shouldn't kill the whole feature.
        const out: SnapshotMap = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (
                v &&
                typeof v === "object" &&
                Array.isArray((v as ExportSnapshot).trackIds) &&
                (v as ExportSnapshot).trackIds.every((n) => typeof n === "number") &&
                typeof (v as ExportSnapshot).exportedAt === "string"
            ) {
                out[k] = v as ExportSnapshot;
            }
        }
        return out;
    } catch {
        return {};
    }
}

function writeMap(format: ExportFormat, map: SnapshotMap): void {
    if (!isBrowser) return;
    try {
        // Cap by exportedAt descending; oldest entries fall off.
        const entries = Object.entries(map);
        if (entries.length > MAX_PLAYLISTS_TRACKED) {
            entries.sort((a, b) => (a[1].exportedAt < b[1].exportedAt ? 1 : -1));
            const keep = Object.fromEntries(entries.slice(0, MAX_PLAYLISTS_TRACKED));
            window.localStorage.setItem(storageKey(format), JSON.stringify(keep));
            return;
        }
        window.localStorage.setItem(storageKey(format), JSON.stringify(map));
    } catch {
        // Quota / privacy mode — fall through silently. The diff just
        // won't have a baseline next time, which degrades gracefully.
    }
}

/** Return the snapshot for one playlist, or null if there isn't one. */
export function getExportSnapshot(
    format: ExportFormat,
    playlistId: number,
): ExportSnapshot | null {
    return readMap(format)[String(playlistId)] ?? null;
}

/** Persist the latest exported track ids for one playlist + format. */
export function recordExportSnapshot(
    format: ExportFormat,
    playlistId: number,
    trackIds: number[],
): void {
    const map = readMap(format);
    map[String(playlistId)] = {
        trackIds: [...trackIds],
        exportedAt: new Date().toISOString(),
    };
    writeMap(format, map);
}

/**
 * Pure diff between a previous snapshot and the current track set.
 * Exported standalone so it's testable without touching localStorage.
 */
export function diffExport(
    previous: ExportSnapshot | null,
    currentTrackIds: number[],
): ExportDiff {
    if (!previous) {
        return {
            added: [...currentTrackIds],
            removed: [],
            unchanged: [],
            hasPrevious: false,
            previousAt: null,
        };
    }
    const prev = new Set(previous.trackIds);
    const curr = new Set(currentTrackIds);
    const added: number[] = [];
    const removed: number[] = [];
    const unchanged: number[] = [];
    for (const id of currentTrackIds) {
        if (prev.has(id)) unchanged.push(id);
        else added.push(id);
    }
    for (const id of previous.trackIds) {
        if (!curr.has(id)) removed.push(id);
    }
    return { added, removed, unchanged, hasPrevious: true, previousAt: previous.exportedAt };
}

/** Convenience: read and diff in one call. */
export function getExportDiff(
    format: ExportFormat,
    playlistId: number,
    currentTrackIds: number[],
): ExportDiff {
    return diffExport(getExportSnapshot(format, playlistId), currentTrackIds);
}
