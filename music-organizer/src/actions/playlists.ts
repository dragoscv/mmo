"use server";

import { db } from "@/db";
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
        WHERE playlist_tracks.playlist_id = ${playlists.id}
      )`,
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
