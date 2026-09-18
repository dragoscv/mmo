/**
 * Listen-half types for Media Home (WP11-05). Pure types — shared by the
 * server actions (`actions/track-plays.ts`, `actions/playlists-aggregate.ts`)
 * and the client cards under `components/media/`.
 */
import type { CompanionTrack, PlaylistSummary } from "@/lib/companion-library";

export type Track = CompanionTrack;

/** A track with resume info — feeds "Continue listening". */
export interface TrackWithProgress extends CompanionTrack {
    playedAt: string;
    completed: boolean;
    /** Seconds listened in the last play. */
    lastDurationSec: number | null;
    /** 0..1 fraction of the track already heard (0 when unknown). */
    progress: number;
}

/** Album grouped from the cloud `tracks` table (album + artist). */
export interface Album {
    /** Stable key: `${artist}\u001f${album}` (lower-cased). */
    key: string;
    title: string;
    artist: string | null;
    year?: number | null;
    cover?: string | null;
    trackCount: number;
    /** Cloud `tracks.id` list, in disc/track order when known. */
    trackIds: number[];
}

/** Playlist from one companion, tagged with its origin server. */
export interface PlaylistWithSource extends PlaylistSummary {
    source: { serverId: string; serverName: string; online: boolean };
}

export interface ListenHome {
    continue: TrackWithProgress[];
    recentAlbums: Album[];
    favourites: CompanionTrack[];
    playlists: PlaylistWithSource[];
    mostPlayed: CompanionTrack[];
}

export const EMPTY_LISTEN_HOME: ListenHome = {
    continue: [],
    recentAlbums: [],
    favourites: [],
    playlists: [],
    mostPlayed: [],
};

export function albumKey(artist: string | null | undefined, album: string): string {
    return `${(artist ?? "").trim().toLowerCase()}\u001f${album.trim().toLowerCase()}`;
}

export function trackProgress(listenedSec: number | null | undefined, durationSec: number | null | undefined): number {
    if (!listenedSec || !durationSec || durationSec <= 0) return 0;
    return Math.max(0, Math.min(1, listenedSec / durationSec));
}
