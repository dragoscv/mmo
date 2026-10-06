/**
 * star / unstar / setRating / scrobble.
 *
 * Writes go through the same columns `/library` uses (`is_favorite`,
 * `rating`) and are pushed to cloud sync via `enqueueSyncChange` exactly
 * like `routes.ts` does, so a star in Symfonium shows up in the web app.
 */

import { enqueueSyncChange } from "../sync";
import { db, getTrack, tracksForId } from "./browse";
import { decodeId } from "./ids";
import { ERR, SubsonicError } from "./response";

function pushTrack(userId: string, id: number): void {
    try {
        const row = db().prepare(`SELECT * FROM tracks WHERE id = ? AND user_id = ?`).get(id, userId) as
            | ({ id: number; user_id: string; sha256?: string | null } & Record<string, unknown>) | undefined;
        if (!row) return;
        const sha = (row.sha256 ?? "") as string;
        enqueueSyncChange({
            entity: "tracks",
            entityId: sha || `${userId}:${row.id}`,
            op: "upsert",
            payload: { sha256: sha || undefined, ...row, userId, companionTrackId: row.id },
            updatedAt: new Date().toISOString(),
        });
    } catch { /* sync is best-effort */ }
}

/** Collect every track id covered by the given Subsonic ids (song, album or artist). */
function expandIds(userId: string, ids: string[]): number[] {
    const out = new Set<number>();
    for (const raw of ids) {
        const d = decodeId(raw);
        if (!d) throw new SubsonicError(ERR.NOT_FOUND, `Unknown id: ${raw}`);
        for (const t of tracksForId(userId, d)) out.add(t.id);
    }
    return [...out];
}

export function setStarred(userId: string, ids: string[], starred: boolean): void {
    const trackIds = expandIds(userId, ids);
    const stmt = db().prepare(`UPDATE tracks SET is_favorite = ? WHERE id = ? AND user_id = ?`);
    const tx = db().transaction((list: number[]) => { for (const id of list) stmt.run(starred ? 1 : 0, id, userId); });
    tx(trackIds);
    for (const id of trackIds) pushTrack(userId, id);
}

export function setRating(userId: string, id: string, rating: number): void {
    const d = decodeId(id);
    if (!d || d.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, "setRating supports song ids only");
    if (!getTrack(userId, d.num!)) throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
    const next = rating <= 0 ? null : Math.min(5, Math.max(1, Math.round(rating)));
    db().prepare(`UPDATE tracks SET rating = ? WHERE id = ? AND user_id = ?`).run(next, d.num, userId);
    pushTrack(userId, d.num!);
}

/**
 * Record a play. The `tracks` table has no play_count / last_played
 * column (verified against library/schema.ts + db.ts bootstrap), so a
 * submission is validated and acknowledged but persists nothing.
 * `submission=false` ("now playing") is a no-op by spec.
 */
export function scrobble(userId: string, ids: string[], submission: boolean): { counted: number } {
    let counted = 0;
    for (const raw of ids) {
        const d = decodeId(raw);
        if (!d || d.kind !== "track") throw new SubsonicError(ERR.NOT_FOUND, `Unknown song id: ${raw}`);
        if (!getTrack(userId, d.num!)) throw new SubsonicError(ERR.NOT_FOUND, "Song not found");
        if (submission) counted++;
    }
    return { counted };
}
