"use server";

/**
 * Listen history (WP11-02) — server-side play log in `track_plays`, feeding
 * the Media Home "Listen" rows (Continue listening, Recently played, New
 * albums, Favourites). The player calls `recordTrackPlay` fire-and-forget;
 * localStorage `playHistory` remains the offline fallback.
 */

import { z } from "zod";
import { and, count, desc, eq, inArray, max, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db } from "@/db";
import { trackPlays, tracks } from "@/db/schema";
import { getActiveProfileId } from "@/lib/active-profile";
import { rowToCompanionTrack } from "@/lib/cloud-library";
import type { CompanionTrack } from "@/lib/companion-library";
import { albumKey, trackProgress, type Album, type ListenHome, type TrackWithProgress } from "@/lib/media/listen-types";
import { log } from "@/lib/logger";
import { getPlaylistsAggregated } from "./playlists-aggregate";

const recordSchema = z.object({
    /** Companion-side track id (what the player carries) or cloud id. */
    trackId: z.number().int().positive(),
    durationSec: z.number().int().min(0).max(60 * 60 * 24).optional(),
    completed: z.boolean().default(false),
    source: z.enum(["web", "companion", "tv"]).default("web"),
    deviceId: z.string().min(1).max(128).optional(),
});

export type RecordTrackPlayInput = z.input<typeof recordSchema>;

const limitSchema = z.number().int().min(1).max(100);

async function userId(): Promise<string | null> {
    const session = await auth();
    return session?.user?.id ?? null;
}

/** Resolve the cloud `tracks.id` for a player-side id (companionTrackId first, then cloud id). */
async function resolveCloudTrackId(uid: string, id: number): Promise<number | null> {
    const rows = await db.select({ id: tracks.id, companionTrackId: tracks.companionTrackId }).from(tracks)
        .where(and(eq(tracks.userId, uid), or(eq(tracks.companionTrackId, id), eq(tracks.id, id))))
        .limit(2);
    return rows.find((r) => r.companionTrackId === id)?.id ?? rows[0]?.id ?? null;
}

export async function recordTrackPlay(input: RecordTrackPlayInput): Promise<{ ok: boolean; error?: string }> {
    const parsed = recordSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" };
    const uid = await userId();
    if (!uid) return { ok: false, error: "unauthenticated" };
    try {
        const cloudId = await resolveCloudTrackId(uid, parsed.data.trackId);
        if (!cloudId) return { ok: false, error: "unknown-track" };
        const profileId = await getActiveProfileId();
        await db.insert(trackPlays).values({
            userId: uid,
            profileId,
            trackId: cloudId,
            deviceId: parsed.data.deviceId ?? null,
            durationSec: parsed.data.durationSec ?? null,
            completed: parsed.data.completed,
            source: parsed.data.source,
        });
        revalidatePath("/");
        return { ok: true };
    } catch (err) {
        log.warn("trackPlays.record failed", undefined, err);
        return { ok: false, error: "failed" };
    }
}

export interface PlayedTrack extends CompanionTrack {
    playedAt: string;
    completed: boolean;
    /** Seconds listened in the last play (Continue listening resume hint). */
    lastDurationSec: number | null;
}

type TrackRow = typeof tracks.$inferSelect;

function toPlayed(row: TrackRow, playedAt: Date, completed: boolean, lastDurationSec: number | null): PlayedTrack {
    return { ...rowToCompanionTrack(row), playedAt: playedAt.toISOString(), completed, lastDurationSec };
}

/** Latest play per track for the user, newest first (limit applied after dedupe). */
async function latestPlaysPerTrack(uid: string, limit: number, onlyIncomplete: boolean) {
    // Newest play per track via DISTINCT ON; then filter/limit in SQL.
    const latest = db
        .selectDistinctOn([trackPlays.trackId], {
            trackId: trackPlays.trackId,
            playedAt: trackPlays.playedAt,
            completed: trackPlays.completed,
            durationSec: trackPlays.durationSec,
        })
        .from(trackPlays)
        .where(eq(trackPlays.userId, uid))
        .orderBy(trackPlays.trackId, desc(trackPlays.playedAt))
        .as("latest");
    const rows = await db
        .select({ track: tracks, playedAt: latest.playedAt, completed: latest.completed, durationSec: latest.durationSec })
        .from(latest)
        .innerJoin(tracks, eq(tracks.id, latest.trackId))
        .where(onlyIncomplete ? eq(latest.completed, false) : undefined)
        .orderBy(desc(latest.playedAt))
        .limit(limit);
    return rows.map((r) => toPlayed(r.track, r.playedAt, r.completed, r.durationSec));
}

/** Tracks whose LAST play did not finish — resume candidates. */
export async function getContinueListening(limit = 12): Promise<PlayedTrack[]> {
    const uid = await userId();
    if (!uid) return [];
    try {
        return await latestPlaysPerTrack(uid, limitSchema.parse(limit), true);
    } catch (err) {
        log.warn("trackPlays.continue failed", undefined, err);
        return [];
    }
}

/** Distinct tracks by most recent play. */
export async function getRecentlyPlayed(limit = 20): Promise<PlayedTrack[]> {
    const uid = await userId();
    if (!uid) return [];
    try {
        return await latestPlaysPerTrack(uid, limitSchema.parse(limit), false);
    } catch (err) {
        log.warn("trackPlays.recent failed", undefined, err);
        return [];
    }
}

export interface AlbumCard {
    album: string;
    artist: string | null;
    cover: string | null;
    trackCount: number;
    /** ISO of the newest track added to this album. */
    addedAt: string | null;
    year: number | null;
}

/** Albums ordered by the most recently added track (cover = first non-null artwork). */
export async function getNewAlbums(limit = 12): Promise<AlbumCard[]> {
    const uid = await userId();
    if (!uid) return [];
    try {
        const rows = await db
            .select({
                album: tracks.album,
                artist: tracks.artist,
                cover: sql<string | null>`(array_remove(array_agg(${tracks.artworkUrl} order by ${tracks.addedAt} desc), null))[1]`,
                trackCount: sql<number>`count(*)::int`,
                addedAt: max(tracks.addedAt),
                year: max(tracks.year),
            })
            .from(tracks)
            .where(and(eq(tracks.userId, uid), eq(tracks.isHidden, false), sql`${tracks.album} is not null and ${tracks.album} <> ''`))
            .groupBy(tracks.album, tracks.artist)
            .orderBy(desc(max(tracks.addedAt)))
            .limit(limitSchema.parse(limit));
        return rows.map((r) => ({
            album: r.album ?? "",
            artist: r.artist,
            cover: r.cover,
            trackCount: Number(r.trackCount),
            addedAt: r.addedAt ? new Date(r.addedAt).toISOString() : null,
            year: r.year ?? null,
        }));
    } catch (err) {
        log.warn("trackPlays.newAlbums failed", undefined, err);
        return [];
    }
}

/** Favourite (hearted) tracks, newest first. */
export async function getFavouriteTracks(limit = 20): Promise<CompanionTrack[]> {
    const uid = await userId();
    if (!uid) return [];
    try {
        const rows = await db.select().from(tracks)
            .where(and(eq(tracks.userId, uid), eq(tracks.isFavorite, true), eq(tracks.isHidden, false)))
            .orderBy(desc(tracks.updatedAt), desc(tracks.addedAt))
            .limit(limitSchema.parse(limit));
        return rows.map(rowToCompanionTrack);
    } catch (err) {
        log.warn("trackPlays.favourites failed", undefined, err);
        return [];
    }
}

/** Resolve a list of cloud track ids to CompanionTracks, in the requested
 *  order (the returned `id` is the companion id, so callers cannot re-sort). */
export async function getTracksByCloudIds(ids: number[]): Promise<CompanionTrack[]> {
    const uid = await userId();
    if (!uid || ids.length === 0) return [];
    const rows = await db.select().from(tracks).where(and(eq(tracks.userId, uid), inArray(tracks.id, ids)));
    const byCloudId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byCloudId.get(id)).filter((r): r is TrackRow => !!r).map(rowToCompanionTrack);
}

/** Tracks ranked by play count (all time), ties broken by most recent play. */
export async function getMostPlayed(limit = 20): Promise<CompanionTrack[]> {
    const uid = await userId();
    if (!uid) return [];
    try {
        const plays = count(trackPlays.id);
        const rows = await db
            .select({ track: tracks, plays, last: max(trackPlays.playedAt) })
            .from(trackPlays)
            .innerJoin(tracks, eq(tracks.id, trackPlays.trackId))
            .where(and(eq(trackPlays.userId, uid), eq(tracks.isHidden, false)))
            .groupBy(tracks.id)
            .orderBy(desc(plays), desc(max(trackPlays.playedAt)))
            .limit(limitSchema.parse(limit));
        return rows.map((r) => rowToCompanionTrack(r.track));
    } catch (err) {
        log.warn("trackPlays.mostPlayed failed", undefined, err);
        return [];
    }
}

/** Albums (title+artist) ordered by newest added track, with their cloud track ids for queueing. */
export async function getRecentAlbums(limit = 12): Promise<Album[]> {
    const uid = await userId();
    if (!uid) return [];
    try {
        const rows = await db
            .select({
                album: tracks.album,
                artist: tracks.artist,
                cover: sql<string | null>`(array_remove(array_agg(${tracks.artworkUrl} order by ${tracks.addedAt} desc), null))[1]`,
                trackCount: sql<number>`count(*)::int`,
                trackIds: sql<number[]>`array_agg(${tracks.id} order by ${tracks.filename})`,
                year: max(tracks.year),
            })
            .from(tracks)
            .where(and(eq(tracks.userId, uid), eq(tracks.isHidden, false), sql`${tracks.album} is not null and ${tracks.album} <> ''`))
            .groupBy(tracks.album, tracks.artist)
            .orderBy(desc(max(tracks.addedAt)))
            .limit(limitSchema.parse(limit));
        return rows.map((r) => {
            const title = r.album ?? "";
            return {
                key: albumKey(r.artist, title),
                title,
                artist: r.artist,
                year: r.year ?? null,
                cover: r.cover,
                trackCount: Number(r.trackCount),
                trackIds: (r.trackIds ?? []).map(Number),
            };
        });
    } catch (err) {
        log.warn("trackPlays.recentAlbums failed", undefined, err);
        return [];
    }
}

function withProgress(t: PlayedTrack): TrackWithProgress {
    return { ...t, progress: trackProgress(t.lastDurationSec, t.duration) };
}

/** Everything the Listen half of Media Home needs, fetched in parallel. */
export async function getListenHome(): Promise<ListenHome> {
    const [cont, recentAlbums, favourites, playlists, mostPlayed] = await Promise.all([
        getContinueListening(12),
        getRecentAlbums(12),
        getFavouriteTracks(20),
        getPlaylistsAggregated(),
        getMostPlayed(20),
    ]);
    return { continue: cont.map(withProgress), recentAlbums, favourites, playlists, mostPlayed };
}
