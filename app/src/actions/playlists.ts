"use server";

/**
 * Playlist server actions — thin client over the companion's
 * /library/playlists/* API.
 *
 * Same auth model as `tracks.ts`: no companion → empty reads, error
 * writes. Recommended-playlist catalog is static and lives in this
 * file (no DB needed).
 */

import { revalidatePath } from "next/cache";
import {
    companionLibrary,
    getCompanionLink,
    type PaginatedPlaylistTracks,
    type PlaylistSummary,
} from "@/lib/companion-library";

export type { PlaylistSummary, PaginatedPlaylistTracks } from "@/lib/companion-library";

const EMPTY_PAGED_PLAYLIST: PaginatedPlaylistTracks = {
    tracks: [], total: 0, page: 1, pageSize: 50, totalPages: 0,
};

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getPlaylists(): Promise<PlaylistSummary[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try { return await companionLibrary.getPlaylists(link); }
    catch (err) {
        console.warn("[playlists] getPlaylists failed:", err);
        return [];
    }
}

export async function getPlaylistTracks(
    playlistId: number,
    page = 1,
    pageSize = 50,
): Promise<PaginatedPlaylistTracks> {
    const link = await getCompanionLink();
    if (!link) return EMPTY_PAGED_PLAYLIST;
    try {
        return await companionLibrary.getPlaylistTracks(link, playlistId, page, pageSize);
    } catch (err) {
        console.warn("[playlists] getPlaylistTracks failed:", err);
        return EMPTY_PAGED_PLAYLIST;
    }
}

/** Returns playlists the given track is currently a member of. Currently
 *  derived client-side from the full playlist list — the per-track lookup
 *  endpoint is not yet exposed by the companion. */
export async function getPlaylistsForTrack(
    trackId: number,
): Promise<{ id: number; name: string }[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try {
        const playlists = await companionLibrary.getPlaylists(link);
        const memberOf: { id: number; name: string }[] = [];
        // Walk playlists; bail out as soon as we find membership entries.
        // Bounded by playlist count, not track count.
        for (const pl of playlists) {
            const r = await companionLibrary.getPlaylistTracks(link, pl.id, 1, 500);
            if (r.tracks.some((t) => t.id === trackId)) {
                memberOf.push({ id: pl.id, name: pl.name });
            }
        }
        return memberOf;
    } catch {
        return [];
    }
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export async function createPlaylist(
    name: string,
    description?: string,
): Promise<PlaylistSummary> {
    const link = await getCompanionLink();
    if (!link) throw new Error("Companion not connected");
    const pl = await companionLibrary.createPlaylist(link, name, description);
    revalidatePath("/playlists");
    return pl;
}

export async function updatePlaylist(
    id: number,
    data: { name?: string; description?: string },
): Promise<{ success: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.updatePlaylist(link, id, data);
        revalidatePath("/playlists");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Update failed" };
    }
}

export async function deletePlaylist(
    id: number,
): Promise<{ success: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.deletePlaylist(link, id);
        revalidatePath("/playlists");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Delete failed" };
    }
}

export async function addTracksToPlaylist(
    playlistId: number,
    trackIds: number[],
): Promise<{ success: boolean; added: number; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, added: 0, error: "Companion not connected" };
    try {
        const r = await companionLibrary.addTracksToPlaylist(link, playlistId, trackIds);
        revalidatePath("/playlists");
        return { success: true, added: r.added };
    } catch (err) {
        return { success: false, added: 0, error: err instanceof Error ? err.message : "Add failed" };
    }
}

export async function removeTrackFromPlaylist(
    playlistId: number,
    trackId: number,
): Promise<{ success: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.removeTrackFromPlaylist(link, playlistId, trackId);
        revalidatePath("/playlists");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Remove failed" };
    }
}

export async function moveTrackInPlaylist(
    _playlistId: number,
    _trackId: number,
    _direction: "up" | "down",
): Promise<{ success: boolean; error?: string }> {
    void _playlistId; void _trackId; void _direction;
    // TODO(companion): move-position endpoint. Not blocking for v1.
    return { success: false, error: "Reordering not yet supported via companion" };
}

export async function clearPlaylist(
    playlistId: number,
): Promise<{ success: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        const { tracks } = await companionLibrary.getPlaylistTracks(link, playlistId, 1, 1000);
        for (const t of tracks) {
            await companionLibrary.removeTrackFromPlaylist(link, playlistId, t.id);
        }
        revalidatePath("/playlists");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Clear failed" };
    }
}

export async function duplicatePlaylist(
    playlistId: number,
): Promise<PlaylistSummary> {
    const link = await getCompanionLink();
    if (!link) throw new Error("Companion not connected");
    const all = await companionLibrary.getPlaylists(link);
    const original = all.find((p) => p.id === playlistId);
    if (!original) throw new Error("Playlist not found");

    const copy = await companionLibrary.createPlaylist(
        link,
        `${original.name} (Copy)`,
        original.description ?? undefined,
    );
    const { tracks } = await companionLibrary.getPlaylistTracks(link, playlistId, 1, 100000);
    if (tracks.length > 0) {
        await companionLibrary.addTracksToPlaylist(link, copy.id, tracks.map((t) => t.id));
    }
    revalidatePath("/playlists");
    return copy;
}

// ─── XML export (rekordbox compatible) ──────────────────────────────────────

function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function encodeRekordboxLocation(filepath: string): string {
    const normalized = filepath.replace(/\\/g, "/");
    return "file://localhost/" + normalized.split("/").map(encodeURIComponent).join("/");
}

export async function exportPlaylistToXml(playlistId: number): Promise<string> {
    const link = await getCompanionLink();
    if (!link) throw new Error("Companion not connected");
    const all = await companionLibrary.getPlaylists(link);
    const playlist = all.find((p) => p.id === playlistId);
    if (!playlist) throw new Error("Playlist not found");

    const { tracks } = await companionLibrary.getPlaylistTracks(link, playlistId, 1, 100000);

    const xmlTracks = tracks.map((t) => {
        const attrs = [
            `TrackID="${t.id}"`,
            `Name="${escapeXml(t.title || t.filename)}"`,
            `Artist="${escapeXml(t.artist || "")}"`,
            `Album="${escapeXml(t.album || "")}"`,
            `Genre="${escapeXml(t.genre || "")}"`,
            `Location="${escapeXml(encodeRekordboxLocation(t.filepath))}"`,
        ];
        if (t.bpm) attrs.push(`AverageBpm="${t.bpm.toFixed(2)}"`);
        if (t.keyCamelot) attrs.push(`Tonality="${escapeXml(t.keyCamelot)}"`);
        if (t.duration) attrs.push(`TotalTime="${t.duration}"`);
        return `    <TRACK ${attrs.join(" ")} />`;
    }).join("\n");

    const xmlPlaylistTracks = tracks.map((t) => `        <TRACK Key="${t.id}" />`).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="MMO" Version="1.0" Company="MMO"/>
  <COLLECTION Entries="${tracks.length}">
${xmlTracks}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="${escapeXml(playlist.name)}" Type="1" KeyType="0" Entries="${tracks.length}">
${xmlPlaylistTracks}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;
}

export async function exportAllPlaylistsToXml(): Promise<string> {
    const link = await getCompanionLink();
    if (!link) throw new Error("Companion not connected");
    const playlists = await companionLibrary.getPlaylists(link);

    type AnyTrack = NonNullable<Awaited<ReturnType<typeof companionLibrary.getPlaylistTracks>>>["tracks"][number];
    const allTracks = new Map<number, AnyTrack>();
    const playlistData: { name: string; trackIds: number[] }[] = [];

    for (const pl of playlists) {
        const { tracks } = await companionLibrary.getPlaylistTracks(link, pl.id, 1, 100000);
        const trackIds: number[] = [];
        for (const t of tracks) {
            allTracks.set(t.id, t);
            trackIds.push(t.id);
        }
        playlistData.push({ name: pl.name, trackIds });
    }

    const xmlTracks = Array.from(allTracks.values()).map((t) => {
        const attrs = [
            `TrackID="${t.id}"`,
            `Name="${escapeXml(t.title || t.filename)}"`,
            `Artist="${escapeXml(t.artist || "")}"`,
            `Album="${escapeXml(t.album || "")}"`,
            `Genre="${escapeXml(t.genre || "")}"`,
            `Location="${escapeXml(encodeRekordboxLocation(t.filepath))}"`,
        ];
        if (t.bpm) attrs.push(`AverageBpm="${t.bpm.toFixed(2)}"`);
        if (t.keyCamelot) attrs.push(`Tonality="${escapeXml(t.keyCamelot)}"`);
        if (t.duration) attrs.push(`TotalTime="${t.duration}"`);
        return `    <TRACK ${attrs.join(" ")} />`;
    }).join("\n");

    const xmlPlaylists = playlistData.map((pl) => {
        const trackNodes = pl.trackIds.map((id) => `        <TRACK Key="${id}" />`).join("\n");
        return `      <NODE Name="${escapeXml(pl.name)}" Type="1" KeyType="0" Entries="${pl.trackIds.length}">\n${trackNodes}\n      </NODE>`;
    }).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="MMO" Version="1.0" Company="MMO"/>
  <COLLECTION Entries="${allTracks.size}">
${xmlTracks}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="${playlistData.length}">
${xmlPlaylists}
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;
}

// ─── Recommended Playlists (static catalog, no DB) ──────────────────────────

export interface RecommendedPlaylist {
    name: string;
    description: string;
    category: string;
    icon: string;
    exists: boolean;
}

export interface RecommendedCategory {
    category: string;
    icon: string;
    description: string;
    playlists: RecommendedPlaylist[];
    existingCount: number;
    totalCount: number;
}

const RECOMMENDED_PLAYLISTS: { name: string; description: string; category: string; icon: string }[] = [
    { name: "Techno", description: "Techno tracks, 125-145 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Tech House", description: "Tech House grooves, 122-128 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Acid", description: "Acid sounds, 125-140 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Psytrance", description: "Psytrance, 138-150 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Bounce", description: "Bounce & hard dance, 150-165 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Manele", description: "Manele tracks, 85-130 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Populară", description: "Muzică populară românească, 80-140 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Balkanică", description: "Balkan beats, 90-160 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Latino", description: "Latin & reggaeton, 85-130 BPM", category: "Per Genre", icon: "🎵" },
    { name: "House", description: "House music, 120-130 BPM", category: "Per Genre", icon: "🎵" },
    { name: "Progressive House", description: "Progressive house, 126-132 BPM", category: "Per Genre", icon: "🎵" },
    { name: "1-Warmup", description: "Chill, intro tracks — low energy openers", category: "Per Energy", icon: "⚡" },
    { name: "2-Build", description: "Building energy — crescendo tracks", category: "Per Energy", icon: "⚡" },
    { name: "3-Peak", description: "Maximum energy — peak time bangers", category: "Per Energy", icon: "⚡" },
    { name: "4-Cooldown", description: "Winding down — closing & emotional", category: "Per Energy", icon: "⚡" },
    { name: "Techno × Manele", description: "Fusion bridge tracks: Techno meets Manele", category: "Fusions", icon: "🔥" },
    { name: "Bounce × Balkan", description: "Fusion bridge tracks: Bounce meets Balkan", category: "Fusions", icon: "🔥" },
    { name: "Tech House × Latino", description: "Tribal tech & Latin house crossovers", category: "Fusions", icon: "🔥" },
    { name: "Acid × Psytrance", description: "Acid psy crossovers", category: "Fusions", icon: "🔥" },
    { name: "Balkan × Techno", description: "Balkan beats meets techno", category: "Fusions", icon: "🔥" },
    { name: "Practice 001", description: "First practice set", category: "Set Building", icon: "📅" },
    { name: "Practice 002", description: "Second practice set", category: "Set Building", icon: "📅" },
    { name: "Live Event 001", description: "First live event set", category: "Set Building", icon: "📅" },
    { name: "Top Favourites", description: "Your all-time favourite tracks", category: "Specials", icon: "⭐" },
    { name: "Recent Adds", description: "Recently added tracks (last 30 days)", category: "Specials", icon: "⭐" },
    { name: "Clasice / Evergreen", description: "Timeless classics that always work", category: "Specials", icon: "⭐" },
    { name: "5 Star Only", description: "Secret weapons — your best rated tracks", category: "Specials", icon: "⭐" },
];

const CATEGORY_META: Record<string, { icon: string; description: string }> = {
    "Per Genre": { icon: "🎵", description: "One playlist per genre for easy browsing" },
    "Per Energy": { icon: "⚡", description: "Organize by energy level for set building" },
    "Fusions": { icon: "🔥", description: "Bridge tracks for genre transitions" },
    "Set Building": { icon: "📅", description: "Practice sets and live event preparation" },
    "Specials": { icon: "⭐", description: "Smart collections and favourites" },
};

export async function getRecommendedPlaylists(): Promise<RecommendedCategory[]> {
    const link = await getCompanionLink();
    let existingNames = new Set<string>();
    if (link) {
        try {
            const existing = await companionLibrary.getPlaylists(link);
            existingNames = new Set(existing.map((p) => p.name.toLowerCase()));
        } catch { /* keep empty set */ }
    }

    const categorized = new Map<string, RecommendedPlaylist[]>();
    for (const rec of RECOMMENDED_PLAYLISTS) {
        const list = categorized.get(rec.category) ?? [];
        list.push({ ...rec, exists: existingNames.has(rec.name.toLowerCase()) });
        categorized.set(rec.category, list);
    }

    const categories: RecommendedCategory[] = [];
    for (const [category, items] of categorized) {
        const meta = CATEGORY_META[category] ?? { icon: "📋", description: "" };
        categories.push({
            category, icon: meta.icon, description: meta.description,
            playlists: items,
            existingCount: items.filter((p) => p.exists).length,
            totalCount: items.length,
        });
    }
    return categories;
}

export async function createRecommendedPlaylists(
    names: string[],
): Promise<{ created: number; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { created: 0, error: "Companion not connected" };
    try {
        const valid = RECOMMENDED_PLAYLISTS.filter((r) => names.includes(r.name));
        const existing = await companionLibrary.getPlaylists(link);
        const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));
        let created = 0;
        for (const rec of valid) {
            if (!existingNames.has(rec.name.toLowerCase())) {
                await companionLibrary.createPlaylist(link, rec.name, rec.description);
                created++;
            }
        }
        revalidatePath("/playlists");
        return { created };
    } catch (err) {
        return { created: 0, error: err instanceof Error ? err.message : "Create failed" };
    }
}

// ─── Similar tracks (deferred — needs a companion endpoint) ─────────────────

/** TODO(companion): expose a /library/playlists/:id/similar endpoint that
 *  runs the SQL profile-matching logic. For now returns an empty list
 *  rather than crashing — UI handles empty state. */
export async function getSimilarTracks(
    _playlistId: number,
    _limit = 50,
): Promise<unknown[]> {
    void _playlistId; void _limit;
    return [];
}
