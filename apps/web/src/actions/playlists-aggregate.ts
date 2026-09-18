"use server";

/**
 * Playlists across ALL online companions (WP11-05). `actions/playlists.ts`
 * still targets the single auto-picked companion for writes; Media Home
 * needs the union for the "Playlists" row, tagged with the origin server so
 * the card can show a badge and route playback to the right device.
 */

import { aggregateAcrossCompanions, companionLibrary } from "@/lib/companion-library";
import type { PlaylistWithSource } from "@/lib/media/listen-types";
import { log } from "@/lib/logger";

export async function getPlaylistsAggregated(): Promise<PlaylistWithSource[]> {
    try {
        const { results, errors } = await aggregateAcrossCompanions((link) => companionLibrary.getPlaylists(link, 8_000));
        for (const e of errors) log.warn("playlists.aggregate companion failed", { deviceId: e.deviceId, name: e.name }, e.error);
        const out: PlaylistWithSource[] = [];
        for (const { link, value } of results) {
            for (const p of value) {
                out.push({ ...p, source: { serverId: link.deviceId, serverName: link.name, online: link.online } });
            }
        }
        out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.name.localeCompare(b.name));
        return out;
    } catch (err) {
        log.warn("playlists.aggregate failed", undefined, err);
        return [];
    }
}
