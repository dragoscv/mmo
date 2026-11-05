/**
 * Subsonic id scheme (ADR-0005).
 *
 *   tr_<trackId>          song  → tracks.id
 *   al_<hash>             album → sha1(lower(album) + "|" + lower(artist))[0..16]
 *   ar_<hash>             artist → sha1(lower(artist))[0..16]
 *   pl_<playlistId>       playlist → playlists.id
 *
 * Albums/artists have no table of their own — they are GROUP BY views over
 * `tracks` — so their ids are content hashes that stay stable across scans.
 */

import { createHash } from "node:crypto";

export type SubsonicIdKind = "track" | "album" | "artist" | "playlist";

export interface DecodedId {
    kind: SubsonicIdKind;
    /** Numeric row id for track/playlist. */
    num?: number;
    /** Hex hash for album/artist. */
    hash?: string;
}

const PREFIX: Record<SubsonicIdKind, string> = {
    track: "tr_",
    album: "al_",
    artist: "ar_",
    playlist: "pl_",
};

export function normalizeKey(s: string | null | undefined): string {
    return (s ?? "").trim().toLowerCase();
}

export function hashKey(key: string): string {
    return createHash("sha1").update(key, "utf8").digest("hex").slice(0, 16);
}

export function albumHash(album: string | null | undefined, artist: string | null | undefined): string {
    return hashKey(`${normalizeKey(album)}|${normalizeKey(artist)}`);
}

export function artistHash(artist: string | null | undefined): string {
    return hashKey(normalizeKey(artist));
}

export function trackId(id: number): string { return PREFIX.track + id; }
export function playlistId(id: number): string { return PREFIX.playlist + id; }
export function albumId(album: string | null | undefined, artist: string | null | undefined): string {
    return PREFIX.album + albumHash(album, artist);
}
export function artistId(artist: string | null | undefined): string {
    return PREFIX.artist + artistHash(artist);
}

export function decodeId(raw: string | undefined | null): DecodedId | null {
    if (typeof raw !== "string" || raw.length < 4) return null;
    const prefix = raw.slice(0, 3);
    const rest = raw.slice(3);
    switch (prefix) {
        case PREFIX.track:
        case PREFIX.playlist: {
            if (!/^\d+$/.test(rest)) return null;
            const num = Number(rest);
            if (!Number.isSafeInteger(num) || num <= 0) return null;
            return { kind: prefix === PREFIX.track ? "track" : "playlist", num };
        }
        case PREFIX.album:
        case PREFIX.artist: {
            if (!/^[0-9a-f]{16}$/.test(rest)) return null;
            return { kind: prefix === PREFIX.album ? "album" : "artist", hash: rest };
        }
        default:
            return null;
    }
}
