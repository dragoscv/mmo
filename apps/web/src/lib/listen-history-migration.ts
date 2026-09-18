/**
 * One-shot upload of the legacy client-side play history (WP11-05).
 *
 * The player persists `playHistory` (last 50 tracks) inside the
 * `music-organizer-player` localStorage blob. Once the server-side
 * `track_plays` log exists, we push that history up ONCE so "Continue
 * listening" / "Most played" are not empty on day one, then set a flag so
 * it never runs again. Failures leave the flag unset (retry next visit),
 * except `unauthenticated` which is expected for signed-out users.
 */

export const PLAYER_STORAGE_KEY = "music-organizer-player";
export const LISTEN_MIGRATED_FLAG = "mixai:listen-migrated:v1";
export const MAX_ENTRIES = 50;

type Recorder = (input: { trackId: number; durationSec?: number; completed: boolean; source: "web" }) => Promise<{ ok: boolean; error?: string }>;

export interface MigrationResult {
    /** "done" = uploaded (or nothing to upload) and flag set; "skipped" = already migrated / no storage. */
    status: "done" | "skipped" | "unauthenticated" | "failed";
    attempted: number;
    recorded: number;
}

interface LegacyTrack { id?: unknown; duration?: unknown }

export function readLegacyHistory(storage: Pick<Storage, "getItem">): Array<{ trackId: number; durationSec?: number }> {
    let raw: string | null;
    try { raw = storage.getItem(PLAYER_STORAGE_KEY); } catch { return []; }
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as { playHistory?: unknown };
        if (!Array.isArray(parsed.playHistory)) return [];
        const out: Array<{ trackId: number; durationSec?: number }> = [];
        for (const t of parsed.playHistory as LegacyTrack[]) {
            const id = typeof t?.id === "number" ? t.id : Number(t?.id);
            if (!Number.isInteger(id) || id <= 0) continue;
            const d = typeof t.duration === "number" && t.duration > 0 ? Math.round(t.duration) : undefined;
            out.push({ trackId: id, durationSec: d });
        }
        return out.slice(0, MAX_ENTRIES);
    } catch {
        return [];
    }
}

export async function migrateListenHistory(
    record: Recorder,
    storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): Promise<MigrationResult> {
    if (!storage) return { status: "skipped", attempted: 0, recorded: 0 };
    try {
        if (storage.getItem(LISTEN_MIGRATED_FLAG)) return { status: "skipped", attempted: 0, recorded: 0 };
    } catch {
        return { status: "skipped", attempted: 0, recorded: 0 };
    }
    const entries = readLegacyHistory(storage);
    let recorded = 0;
    // Oldest first so `played_at` ordering roughly matches history order
    // (history is stored newest-first).
    for (const e of [...entries].reverse()) {
        let r: { ok: boolean; error?: string };
        try { r = await record({ trackId: e.trackId, durationSec: e.durationSec, completed: true, source: "web" }); }
        catch { r = { ok: false, error: "failed" }; }
        if (r.ok) { recorded++; continue; }
        if (r.error === "unauthenticated") return { status: "unauthenticated", attempted: entries.length, recorded };
        // unknown-track / invalid: not retryable, skip; "failed" (network/db): abort without flag
        if (r.error === "failed") return { status: "failed", attempted: entries.length, recorded };
    }
    try { storage.setItem(LISTEN_MIGRATED_FLAG, new Date().toISOString()); } catch { /* quota */ }
    return { status: "done", attempted: entries.length, recorded };
}
