/**
 * Pure helpers for the TV as a hub MUSIC OUTPUT (server 3.12): parse the `play {trackIds, index, …}` command,
 * order a `/media/music/tracks?ids=` answer, and build the hub `state.media` for a track.
 * No runtime imports, so `node --experimental-strip-types --test` can load it directly.
 */
import type { HubMedia, RepeatMode, TrackCard } from "./media-types";

export interface MusicPlayArgs {
    trackIds: string[];
    index: number;
    positionSec: number;
    shuffle: boolean;
    repeat?: RepeatMode;
}

const MAX_IDS = 2000;

function finite(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return undefined;
}

/** True when a `play` command targets the music queue (has `trackIds`, no `fileId`). */
export function isMusicPlay(args: Record<string, unknown>): boolean {
    const fileId = args.fileId;
    return !(typeof fileId === "string" && fileId !== "") && Array.isArray(args.trackIds);
}

/** `play` args → normalised music play, or null when there is nothing playable. */
export function parseMusicPlayArgs(args: Record<string, unknown>): MusicPlayArgs | null {
    if (!isMusicPlay(args)) return null;
    const trackIds = (args.trackIds as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((x) => x.trim())
        .slice(0, MAX_IDS);
    if (trackIds.length === 0) return null;
    const rawIndex = Math.trunc(finite(args.index) ?? 0);
    const index = Math.max(0, Math.min(trackIds.length - 1, rawIndex));
    const positionSec = Math.max(0, finite(args.positionSec) ?? 0);
    const shuffle = args.shuffle === true;
    const repeat = args.repeat === "off" || args.repeat === "all" || args.repeat === "one" ? args.repeat : undefined;
    return { trackIds, index, positionSec, shuffle, ...(repeat ? { repeat } : {}) };
}

/**
 * Orders `items` by `ids` (dropping anything not requested — an older server ignores `ids` and answers a page
 * of arbitrary tracks) and lists the ids that are still missing.
 */
export function orderTracks(ids: string[], items: readonly TrackCard[] | null | undefined): { tracks: Array<TrackCard | null>; missing: string[] } {
    const byId = new Map<string, TrackCard>();
    for (const t of items ?? []) if (t && typeof t.id === "string") byId.set(t.id, t);
    const tracks = ids.map((id) => byId.get(id) ?? null);
    const missing = ids.filter((_, i) => tracks[i] === null);
    return { tracks, missing };
}

/** Index in the resolved list of the track that was requested at `index` (nearest following one if it failed). */
export function resolvedIndex(slots: Array<TrackCard | null>, index: number): number {
    let pos = 0;
    let fallback = -1;
    for (let i = 0; i < slots.length; i++) {
        if (!slots[i]) continue;
        if (i === index) return pos;
        if (i > index && fallback < 0) fallback = pos;
        pos++;
    }
    if (fallback >= 0) return fallback;
    return Math.max(0, pos - 1);
}

/** Hub `state.media` for a music track. */
export function trackHubMedia(t: Pick<TrackCard, "id" | "title" | "artist" | "album" | "coverUrlPath" | "durationSec">): HubMedia {
    return {
        kind: "track",
        trackId: t.id,
        title: t.title,
        ...(t.artist ? { artist: t.artist } : {}),
        ...(t.album ? { album: t.album } : {}),
        ...(t.coverUrlPath ? { coverUrlPath: t.coverUrlPath } : {}),
        ...(t.durationSec ? { durationSec: t.durationSec } : {}),
    };
}

/**
 * Hub `state` message for a now-playing snapshot (video, live or music); `{idle:true}` when nothing plays.
 * Music media get the live duration copied in (the track card may carry 0 until metadata loads).
 */
export function hubStatePayload(np: { playing: boolean; positionSec: number; durationSec?: number; media?: HubMedia } | null): Record<string, unknown> {
    if (!np) return { type: "state", idle: true };
    const durationSec = np.durationSec && np.durationSec > 0 ? np.durationSec : np.media?.durationSec || undefined;
    const media = np.media && np.media.trackId && durationSec ? { ...np.media, durationSec } : np.media;
    return {
        type: "state",
        playing: np.playing,
        positionSec: Math.max(0, np.positionSec),
        ...(durationSec ? { durationSec } : {}),
        ...(media ? { media } : {}),
    };
}
