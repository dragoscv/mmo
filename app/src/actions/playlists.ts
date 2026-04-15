"use server";

import { db, sqlite } from "@/db";
import { playlists, playlistTracks, tracks } from "@/db/schema";
import { eq, sql, and, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getPlaylists() {
    const result = db
        .select({
            id: playlists.id,
            name: playlists.name,
            description: playlists.description,
            type: playlists.type,
            createdAt: playlists.createdAt,
            trackCount: sql<number>`(
        SELECT COUNT(*) FROM playlist_tracks 
        WHERE playlist_tracks.playlist_id = playlists.id
      )`.mapWith(Number),
        })
        .from(playlists)
        .orderBy(playlists.name)
        .all();

    return result;
}

export async function getPlaylistTracks(
    playlistId: number,
    page: number = 1,
    pageSize: number = 50
) {
    const offset = (page - 1) * pageSize;

    const [countResult] = db
        .select({ count: sql<number>`count(*)` })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .all();

    const total = countResult?.count ?? 0;

    const result = db
        .select({
            id: tracks.id,
            filepath: tracks.filepath,
            filename: tracks.filename,
            artist: tracks.artist,
            title: tracks.title,
            album: tracks.album,
            remix: tracks.remix,
            label: tracks.label,
            bpm: tracks.bpm,
            keyCamelot: tracks.keyCamelot,
            keyMusical: tracks.keyMusical,
            duration: tracks.duration,
            energy: tracks.energy,
            genre: tracks.genre,
            subgenre: tracks.subgenre,
            mood: tracks.mood,
            color: tracks.color,
            vocalType: tracks.vocalType,
            setPosition: tracks.setPosition,
            mixability: tracks.mixability,
            isProcessed: tracks.isProcessed,
            fileSize: tracks.fileSize,
            format: tracks.format,
            bitrate: tracks.bitrate,
            sampleRate: tracks.sampleRate,
            addedAt: tracks.addedAt,
            analyzedAt: tracks.analyzedAt,
            rating: tracks.rating,
            isFavorite: tracks.isFavorite,
            tags: tracks.tags,
            artworkUrl: tracks.artworkUrl,
            musicbrainzId: tracks.musicbrainzId,
            releaseMbid: tracks.releaseMbid,
            year: tracks.year,
            comment: tracks.comment,
            position: playlistTracks.position,
        })
        .from(playlistTracks)
        .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
        .where(eq(playlistTracks.playlistId, playlistId))
        .orderBy(playlistTracks.position)
        .limit(pageSize)
        .offset(offset)
        .all();

    return {
        tracks: result,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
    };
}

export async function createPlaylist(name: string, description?: string) {
    const result = db
        .insert(playlists)
        .values({ name, description, type: "manual" })
        .returning()
        .get();
    revalidatePath("/playlists");
    return result;
}

export async function updatePlaylist(
    id: number,
    data: { name?: string; description?: string }
) {
    db.update(playlists).set(data).where(eq(playlists.id, id)).run();
    revalidatePath("/playlists");
    return { success: true };
}

export async function deletePlaylist(id: number) {
    db.delete(playlistTracks).where(eq(playlistTracks.playlistId, id)).run();
    db.delete(playlists).where(eq(playlists.id, id)).run();
    revalidatePath("/playlists");
    return { success: true };
}

export async function addTracksToPlaylist(
    playlistId: number,
    trackIds: number[]
) {
    // Get current max position
    const maxPos = db
        .select({ maxPos: sql<number>`COALESCE(MAX(position), 0)` })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .get();

    let position = (maxPos?.maxPos ?? 0) + 1;

    // Filter out tracks already in playlist
    const existing = db
        .select({ trackId: playlistTracks.trackId })
        .from(playlistTracks)
        .where(
            and(
                eq(playlistTracks.playlistId, playlistId),
                inArray(playlistTracks.trackId, trackIds)
            )
        )
        .all()
        .map((r) => r.trackId);

    const newTrackIds = trackIds.filter((id) => !existing.includes(id));

    for (const trackId of newTrackIds) {
        db.insert(playlistTracks)
            .values({ playlistId, trackId, position })
            .run();
        position++;
    }

    revalidatePath("/playlists");
    return { success: true, added: newTrackIds.length };
}

export async function removeTrackFromPlaylist(
    playlistId: number,
    trackId: number
) {
    db.delete(playlistTracks)
        .where(
            and(
                eq(playlistTracks.playlistId, playlistId),
                eq(playlistTracks.trackId, trackId)
            )
        )
        .run();
    revalidatePath("/playlists");
    return { success: true };
}

export async function getPlaylistsForTrack(trackId: number) {
    const result = db
        .select({
            id: playlists.id,
            name: playlists.name,
        })
        .from(playlistTracks)
        .innerJoin(playlists, eq(playlistTracks.playlistId, playlists.id))
        .where(eq(playlistTracks.trackId, trackId))
        .all();
    return result;
}

export async function duplicatePlaylist(playlistId: number) {
    const original = db
        .select()
        .from(playlists)
        .where(eq(playlists.id, playlistId))
        .get();
    if (!original) throw new Error("Playlist not found");

    const newPlaylist = db
        .insert(playlists)
        .values({
            name: `${original.name} (Copy)`,
            description: original.description,
            type: "manual",
        })
        .returning()
        .get();

    const originalTracks = db
        .select()
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .orderBy(playlistTracks.position)
        .all();

    for (const pt of originalTracks) {
        db.insert(playlistTracks)
            .values({
                playlistId: newPlaylist.id,
                trackId: pt.trackId!,
                position: pt.position,
            })
            .run();
    }

    revalidatePath("/playlists");
    return newPlaylist;
}

export async function moveTrackInPlaylist(
    playlistId: number,
    trackId: number,
    direction: "up" | "down"
) {
    const allTracks = db
        .select()
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .orderBy(playlistTracks.position)
        .all();

    const idx = allTracks.findIndex((t) => t.trackId === trackId);
    if (idx === -1) return { success: false };

    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= allTracks.length) return { success: false };

    const currentPos = allTracks[idx].position;
    const swapPos = allTracks[swapIdx].position;

    db.update(playlistTracks)
        .set({ position: swapPos })
        .where(eq(playlistTracks.id, allTracks[idx].id))
        .run();
    db.update(playlistTracks)
        .set({ position: currentPos })
        .where(eq(playlistTracks.id, allTracks[swapIdx].id))
        .run();

    revalidatePath("/playlists");
    return { success: true };
}

export async function clearPlaylist(playlistId: number) {
    db.delete(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .run();
    revalidatePath("/playlists");
    return { success: true };
}

function encodeRekordboxLocation(filepath: string): string {
    // Convert Windows path to rekordbox file://localhost/ format
    const normalized = filepath.replace(/\\\\/g, "/");
    const encoded = normalized
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
    return `file://localhost/${encoded}`;
}

export async function exportPlaylistToXml(playlistId: number): Promise<string> {
    const playlist = db
        .select()
        .from(playlists)
        .where(eq(playlists.id, playlistId))
        .get();
    if (!playlist) throw new Error("Playlist not found");

    const { tracks: playlistTrackList } = await getPlaylistTracks(playlistId, 1, 100000);

    // Build rekordbox XML
    const xmlTracks = playlistTrackList
        .map((t) => {
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
        })
        .join("\n");

    const xmlPlaylistTracks = playlistTrackList
        .map((t) => `        <TRACK Key="${t.id}" />`)
        .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="MusicOrganizer" Version="1.0" Company="MusicOrganizer"/>
  <COLLECTION Entries="${playlistTrackList.length}">
${xmlTracks}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="${escapeXml(playlist.name)}" Type="1" KeyType="0" Entries="${playlistTrackList.length}">
${xmlPlaylistTracks}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;
}

export async function exportAllPlaylistsToXml(): Promise<string> {
    const allPlaylists = await getPlaylists();

    // Collect all unique tracks across all playlists
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allTracks = new Map<number, any>();
    const playlistData: Array<{
        name: string;
        trackIds: number[];
    }> = [];

    for (const pl of allPlaylists) {
        const { tracks: plTracks } = await getPlaylistTracks(pl.id, 1, 100000);
        const trackIds: number[] = [];
        for (const t of plTracks) {
            allTracks.set(t.id, t);
            trackIds.push(t.id);
        }
        playlistData.push({ name: pl.name, trackIds });
    }

    const xmlTracks = Array.from(allTracks.values())
        .map((t) => {
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
        })
        .join("\n");

    const xmlPlaylists = playlistData
        .map((pl) => {
            const trackNodes = pl.trackIds
                .map((id) => `        <TRACK Key="${id}" />`)
                .join("\n");
            return `      <NODE Name="${escapeXml(pl.name)}" Type="1" KeyType="0" Entries="${pl.trackIds.length}">\n${trackNodes}\n      </NODE>`;
        })
        .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="MusicOrganizer" Version="1.0" Company="MusicOrganizer"/>
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

function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// ─── Recommended Playlists ──────────────────────────────────────────────────

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

const RECOMMENDED_PLAYLISTS: Array<{
    name: string;
    description: string;
    category: string;
    icon: string;
}> = [
        // ── Per Genre ──
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

        // ── Per Energy ──
        { name: "1-Warmup", description: "Chill, intro tracks — low energy openers", category: "Per Energy", icon: "⚡" },
        { name: "2-Build", description: "Building energy — crescendo tracks", category: "Per Energy", icon: "⚡" },
        { name: "3-Peak", description: "Maximum energy — peak time bangers", category: "Per Energy", icon: "⚡" },
        { name: "4-Cooldown", description: "Winding down — closing & emotional", category: "Per Energy", icon: "⚡" },

        // ── Fusions ──
        { name: "Techno × Manele", description: "Fusion bridge tracks: Techno meets Manele", category: "Fusions", icon: "🔥" },
        { name: "Bounce × Balkan", description: "Fusion bridge tracks: Bounce meets Balkan", category: "Fusions", icon: "🔥" },
        { name: "Tech House × Latino", description: "Tribal tech & Latin house crossovers", category: "Fusions", icon: "🔥" },
        { name: "Acid × Psytrance", description: "Acid psy crossovers", category: "Fusions", icon: "🔥" },
        { name: "Balkan × Techno", description: "Balkan beats meets techno", category: "Fusions", icon: "🔥" },

        // ── Set Building ──
        { name: "Practice 001", description: "First practice set", category: "Set Building", icon: "📅" },
        { name: "Practice 002", description: "Second practice set", category: "Set Building", icon: "📅" },
        { name: "Live Event 001", description: "First live event set", category: "Set Building", icon: "📅" },

        // ── Specials ──
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
    const existing = db
        .select({ name: playlists.name })
        .from(playlists)
        .all();
    const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

    const categorized = new Map<string, RecommendedPlaylist[]>();
    for (const rec of RECOMMENDED_PLAYLISTS) {
        const list = categorized.get(rec.category) ?? [];
        list.push({
            ...rec,
            exists: existingNames.has(rec.name.toLowerCase()),
        });
        categorized.set(rec.category, list);
    }

    const categories: RecommendedCategory[] = [];
    for (const [category, items] of categorized) {
        const meta = CATEGORY_META[category] ?? { icon: "📋", description: "" };
        categories.push({
            category,
            icon: meta.icon,
            description: meta.description,
            playlists: items,
            existingCount: items.filter((p) => p.exists).length,
            totalCount: items.length,
        });
    }

    return categories;
}

export async function createRecommendedPlaylists(
    names: string[]
): Promise<{ created: number }> {
    const valid = RECOMMENDED_PLAYLISTS.filter((r) =>
        names.includes(r.name)
    );

    const existing = db
        .select({ name: playlists.name })
        .from(playlists)
        .all();
    const existingNames = new Set(existing.map((p) => p.name.toLowerCase()));

    let created = 0;
    for (const rec of valid) {
        if (!existingNames.has(rec.name.toLowerCase())) {
            db.insert(playlists)
                .values({
                    name: rec.name,
                    description: rec.description,
                    type: "manual",
                })
                .run();
            created++;
        }
    }

    revalidatePath("/playlists");
    return { created };
}

// ─── Similar Tracks ─────────────────────────────────────────────────────────

export async function getSimilarTracks(playlistId: number, limit = 50) {
    const playlist = db
        .select()
        .from(playlists)
        .where(eq(playlists.id, playlistId))
        .get();
    if (!playlist) return [];

    // IDs already in playlist
    const existingIds = db
        .select({ trackId: playlistTracks.trackId })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, playlistId))
        .all()
        .map((r) => r.trackId!)
        .filter(Boolean);

    // Profile of existing tracks
    const existingTracks = existingIds.length > 0
        ? db
            .select({
                genre: tracks.genre,
                subgenre: tracks.subgenre,
                bpm: tracks.bpm,
                energy: tracks.energy,
                keyCamelot: tracks.keyCamelot,
            })
            .from(tracks)
            .where(inArray(tracks.id, existingIds))
            .all()
        : [];

    // Build scoring expression parts
    const scoreParts: string[] = [];

    if (existingTracks.length > 0) {
        const genres = [...new Set(existingTracks.map((t) => t.genre).filter(Boolean))];
        const subgenres = [...new Set(existingTracks.map((t) => t.subgenre).filter(Boolean))];
        const bpms = existingTracks.map((t) => t.bpm).filter(Boolean) as number[];
        const energies = existingTracks.map((t) => t.energy).filter(Boolean) as number[];
        const keys = [...new Set(existingTracks.map((t) => t.keyCamelot).filter(Boolean))];

        if (genres.length > 0) {
            const escaped = genres.map((g) => `'${g!.replace(/'/g, "''")}'`).join(",");
            scoreParts.push(`(CASE WHEN genre IN (${escaped}) THEN 30 ELSE 0 END)`);
        }
        if (subgenres.length > 0) {
            const escaped = subgenres.map((s) => `'${s!.replace(/'/g, "''")}'`).join(",");
            scoreParts.push(`(CASE WHEN subgenre IN (${escaped}) THEN 10 ELSE 0 END)`);
        }
        if (bpms.length > 0) {
            const minBpm = Math.min(...bpms) - 8;
            const maxBpm = Math.max(...bpms) + 8;
            scoreParts.push(`(CASE WHEN bpm BETWEEN ${minBpm} AND ${maxBpm} THEN 20 ELSE 0 END)`);
        }
        if (energies.length > 0) {
            const minE = Math.max(1, Math.min(...energies) - 1);
            const maxE = Math.min(10, Math.max(...energies) + 1);
            scoreParts.push(`(CASE WHEN energy BETWEEN ${minE} AND ${maxE} THEN 15 ELSE 0 END)`);
        }
        if (keys.length > 0) {
            const escaped = keys.map((k) => `'${k!.replace(/'/g, "''")}'`).join(",");
            scoreParts.push(`(CASE WHEN key_camelot IN (${escaped}) THEN 10 ELSE 0 END)`);
        }
    }

    // Match on playlist name (genre names, keywords)
    const esc = (s: string) => s.replace(/'/g, "''");
    const nameLower = esc(playlist.name.toLowerCase());
    scoreParts.push(`(CASE WHEN LOWER(genre) = '${nameLower}' THEN 25 ELSE 0 END)`);
    scoreParts.push(`(CASE WHEN LOWER(subgenre) = '${nameLower}' THEN 15 ELSE 0 END)`);
    scoreParts.push(`(CASE WHEN LOWER(genre) LIKE '%${nameLower}%' THEN 10 ELSE 0 END)`);
    scoreParts.push(`(CASE WHEN LOWER(title) LIKE '%${nameLower}%' THEN 5 ELSE 0 END)`);
    scoreParts.push(`(CASE WHEN LOWER(artist) LIKE '%${nameLower}%' THEN 5 ELSE 0 END)`);

    const scoreExpr = scoreParts.join(" + ");
    const excludeClause = existingIds.length > 0
        ? `WHERE tracks.id NOT IN (${existingIds.join(",")})`
        : "";

    const rawSql = `
        SELECT * FROM (
            SELECT 
                tracks.id, tracks.filepath, tracks.filename,
                tracks.artist, tracks.title, tracks.album,
                tracks.bpm, tracks.key_camelot, tracks.duration,
                tracks.energy, tracks.genre, tracks.subgenre,
                tracks.mood, tracks.rating, tracks.is_favorite,
                tracks.artwork_url, tracks.tags,
                (${scoreExpr}) as score
            FROM tracks
            ${excludeClause}
        )
        WHERE score > 0
        ORDER BY score DESC, COALESCE(rating, 0) DESC
        LIMIT ?
    `;

    const result = sqlite.prepare(rawSql).all(limit) as Array<{
        id: number;
        filepath: string;
        filename: string;
        artist: string | null;
        title: string | null;
        album: string | null;
        bpm: number | null;
        key_camelot: string | null;
        duration: number | null;
        energy: number | null;
        genre: string | null;
        subgenre: string | null;
        mood: string | null;
        rating: number | null;
        is_favorite: number | null;
        artwork_url: string | null;
        tags: string | null;
        score: number;
    }>;

    return result.map((r) => ({
        id: r.id,
        filepath: r.filepath,
        filename: r.filename,
        artist: r.artist,
        title: r.title,
        album: r.album,
        bpm: r.bpm,
        keyCamelot: r.key_camelot,
        duration: r.duration,
        energy: r.energy,
        genre: r.genre,
        subgenre: r.subgenre,
        mood: r.mood,
        rating: r.rating,
        isFavorite: !!r.is_favorite,
        artworkUrl: r.artwork_url,
        tags: r.tags,
        score: r.score,
    }));
}
