"use server";

import { auth } from "@/auth";
import { getCompanionLink, companionLibrary } from "@/lib/companion-library";

/**
 * Returns the ordered track ids of one playlist, for the export-diff
 * preview. Auth-gated; companion-required (no companion = no playlist
 * data exists in the cloud, so we can't synthesise one).
 *
 * Cap matches the export actions (100 000) so the diff can never be
 * "shorter" than what an actual export would produce.
 */
export async function getPlaylistTrackIds(
    playlistId: number,
): Promise<{ ok: true; trackIds: number[] } | { ok: false; error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "unauthenticated" };
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "no companion" };
    try {
        const { tracks } = await companionLibrary.getPlaylistTracks(link, playlistId, 1, 100000);
        return { ok: true, trackIds: tracks.map((t) => t.id) };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
