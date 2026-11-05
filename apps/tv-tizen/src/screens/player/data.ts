/**
 * Player-side data: skip markers (`/video/intro|recap|credits|chapters/{fileId}`), next-episode resolution
 * (`/media/title/tv/{id}/season/{n}`) and the now-playing media descriptor shared with the hub.
 * Mirrors tv-android `player/PlayerData.kt`.
 */
import type { MmoClient, ProbedVideo } from "../../lib/api";
import type { ServerHttp } from "../../lib/http";
import { enc } from "../../lib/http";
import type { MediaClient } from "../../lib/media";
import type { HubMedia, SeasonEpisode, VersionedFile } from "../../lib/media-types";
import type { TitleRef } from "../../lib/progress-sync";

/** [start, end) in ABSOLUTE media seconds. */
export interface Span { start: number; end: number }
export interface Chapter { start: number; title: string }
export interface Markers { intro: Span | null; recap: Span | null; credits: number | null; chapters: Chapter[] }

export const NO_MARKERS: Markers = { intro: null, recap: null, credits: null, chapters: [] };

/** Marker routes run ffmpeg analyses server-side (idle priority, queued): allow them time. */
const MARKER_TIMEOUT_MS = 150_000;

async function obj(http: ServerHttp, path: string): Promise<Record<string, unknown> | null> {
    try {
        const r = await http.get<Record<string, unknown>>(path, { allow404: true, timeoutMs: MARKER_TIMEOUT_MS });
        return r && typeof r === "object" ? r : null;
    } catch {
        return null;
    }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function fetchSpan(http: ServerHttp, kind: "intro" | "recap", fileId: string): Promise<Span | null> {
    const o = await obj(http, `/video/${kind}/${enc(fileId)}`);
    const s = num(o?.start), e = num(o?.end);
    return s !== null && e !== null && e > s ? { start: s, end: e } : null;
}

export async function fetchCredits(http: ServerHttp, fileId: string): Promise<number | null> {
    const s = num((await obj(http, `/video/credits/${enc(fileId)}`))?.start);
    return s !== null && s > 0 ? s : null;
}

export async function fetchChapters(http: ServerHttp, fileId: string): Promise<Chapter[]> {
    const arr = (await obj(http, `/video/chapters/${enc(fileId)}`))?.chapters;
    if (!Array.isArray(arr)) return [];
    return arr
        .map((c) => (c && typeof c === "object" ? c as Record<string, unknown> : {}))
        .map((c) => ({ start: num(c.start) ?? -1, title: typeof c.title === "string" ? c.title : "" }))
        .filter((c) => c.start >= 0)
        .sort((a, b) => a.start - b.start);
}

// ─── episodes ───────────────────────────────────────────────────────────────

export interface NextEpisode {
    season: number;
    episode: number;
    name: string;
    still: string | null;
    fileId: string;
    path: string;
}

function bestFile(ep: SeasonEpisode): VersionedFile | null {
    let best: VersionedFile | null = null;
    for (const f of ep.files ?? []) {
        if (!f.serverFileId) continue;
        if (!best || (f.version?.rank ?? 0) > (best.version?.rank ?? 0)) best = f;
    }
    return best;
}

function toNext(ep: SeasonEpisode, season: number, media: MediaClient, client: MmoClient): NextEpisode | null {
    const f = bestFile(ep);
    if (!f) return null;
    return {
        season: ep.seasonNumber > 0 ? ep.seasonNumber : season,
        episode: ep.episodeNumber,
        name: ep.name,
        still: media.image(ep.stillPath, "w500") ?? client.stillUrl(f.serverFileId),
        fileId: f.serverFileId,
        path: f.path,
    };
}

/** The next playable episode (has a local file): next number in this season, else the first of the following season. */
export async function resolveNextEpisode(media: MediaClient, client: MmoClient, ref: TitleRef): Promise<NextEpisode | null> {
    if (ref.kind !== "tv" || ref.season == null || ref.episode == null) return null;
    const s = ref.season, e = ref.episode;
    const cur = await media.season(ref.tmdbId, s).catch(() => null);
    const later = (cur?.episodes ?? []).filter((x) => x.episodeNumber > e).sort((a, b) => a.episodeNumber - b.episodeNumber);
    for (const ep of later) {
        const n = toNext(ep, s, media, client);
        if (n) return n;
    }
    const following = await media.season(ref.tmdbId, s + 1).catch(() => null);
    const eps = [...(following?.episodes ?? [])].sort((a, b) => a.episodeNumber - b.episodeNumber);
    for (const ep of eps) {
        const n = toNext(ep, s + 1, media, client);
        if (n) return n;
    }
    return null;
}

/** Current episode title from the season listing (for the S/E line). */
export async function episodeName(media: MediaClient, ref: TitleRef): Promise<string | null> {
    if (ref.kind !== "tv" || ref.season == null || ref.episode == null) return null;
    const s = await media.season(ref.tmdbId, ref.season).catch(() => null);
    return s?.episodes.find((x) => x.episodeNumber === ref.episode)?.name ?? null;
}

export function hubMediaOf(v: ProbedVideo, ref: TitleRef | null): HubMedia {
    return {
        fileId: v.fileId,
        kind: ref?.kind ?? (v.parsed.season != null ? "tv" : "movie"),
        tmdbId: ref?.tmdbId,
        season: ref?.season ?? v.parsed.season ?? undefined,
        episode: ref?.episode ?? v.parsed.episode ?? undefined,
        title: v.parsed.title,
        durationSec: v.durationSec ?? undefined,
    };
}
