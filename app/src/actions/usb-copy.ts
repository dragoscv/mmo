"use server";

/**
 * Server actions backing the USB audio-copy UI.
 *
 * The actual byte-moving runs in the companion (`POST /library/usb/copy`)
 * — the SSE stream from there is proxied to the browser by
 * `app/src/app/api/usb-copy/route.ts`. These actions only resolve the
 * track-id list for a chosen scope so the UI can show "X tracks will be
 * copied" before the user clicks the green button.
 */

import { log } from "@/lib/logger";
import { companionLibrary, getCompanionLink } from "@/lib/companion-library";

export interface UsbScopeSummary {
    ok: boolean;
    trackIds: number[];
    /** Sum of `fileSize` (bytes) for the resolved tracks, when known. */
    totalBytes: number;
    /** How many tracks are missing a `fileSize` value (we still copy them; the
     *  number is just for UI honesty in the "X.X GB" estimate). */
    unknownSizeCount: number;
    error?: string;
}

const EMPTY: UsbScopeSummary = {
    ok: false, trackIds: [], totalBytes: 0, unknownSizeCount: 0, error: "no companion",
};

/**
 * Resolve the track-id list for either a single playlist (`scope=active`)
 * or the entire library (`scope=all`). Hidden tracks are excluded — the
 * user has explicitly hidden them and almost never wants them on a USB.
 */
export async function summariseUsbScope(
    scope: "active" | "all",
    playlistId?: number,
): Promise<UsbScopeSummary> {
    try {
        const link = await getCompanionLink();
        if (!link) return EMPTY;

        if (scope === "active") {
            if (!playlistId || !Number.isInteger(playlistId) || playlistId <= 0) {
                return { ...EMPTY, error: "playlistId required for active scope" };
            }
            const ids: number[] = [];
            let totalBytes = 0;
            let unknown = 0;
            const PAGE = 500;
            for (let page = 1; page <= 10; page++) {
                const r = await companionLibrary.getPlaylistTracks(link, playlistId, page, PAGE);
                for (const t of r.tracks) {
                    if (t.isHidden) continue;
                    ids.push(t.id);
                    if (typeof t.fileSize === "number" && t.fileSize > 0) totalBytes += t.fileSize;
                    else unknown++;
                    if (ids.length >= 5000) break;
                }
                if (ids.length >= 5000 || r.tracks.length < PAGE) break;
            }
            return { ok: true, trackIds: ids, totalBytes, unknownSizeCount: unknown };
        }

        // All-library scope: page through tracks. We cap at the same
        // 5000-id ceiling the companion route enforces to avoid silently
        // truncating; if the user's library is bigger they can use the
        // playlist scope or run multiple passes.
        const ids: number[] = [];
        let totalBytes = 0;
        let unknown = 0;
        const PAGE = 1000;
        for (let page = 1; page <= 5; page++) {
            const r = await companionLibrary.getTracks(link, {
                page, pageSize: PAGE, isHidden: false,
            });
            for (const t of r.tracks) {
                ids.push(t.id);
                if (typeof t.fileSize === "number" && t.fileSize > 0) totalBytes += t.fileSize;
                else unknown++;
                if (ids.length >= 5000) break;
            }
            if (ids.length >= 5000 || r.tracks.length < PAGE) break;
        }
        return { ok: true, trackIds: ids, totalBytes, unknownSizeCount: unknown };
    } catch (err) {
        log.warn("usb.summariseScope failed", undefined, err);
        return { ...EMPTY, error: err instanceof Error ? err.message : "unknown error" };
    }
}
