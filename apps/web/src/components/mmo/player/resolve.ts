/**
 * Title → playable file resolution for `/media/play/[kind]/[tmdbId]` and "Play on TV".
 * Movie: best version (or `file`). TV: the requested episode, else `nextUp`, else the first episode with a
 * local file; files come from the season listing (falls back to the title's file list).
 */
import type { MediaClient } from "@/lib/mmo/media";
import type { MediaKind, MediaTitleResponse, ProgressEntry, SeasonEpisode, VersionedFile } from "@/lib/mmo/media-types";
import { episodeFiles, firstEpisodeWithFile, nextPlayable, pickFile, progressFor, resumePosition, sortVersions } from "./model";

export type TitleSource = Pick<MediaClient, "mediaTitle" | "season">;

export interface ResolveInput {
    kind: MediaKind;
    tmdbId: number;
    file?: string | null;
    season?: number | null;
    episode?: number | null;
    /** Explicit start (s) from `?t=`; null = resume from progress. */
    startSec?: number | null;
}

export interface Resolved {
    title: MediaTitleResponse;
    file: VersionedFile;
    versions: VersionedFile[];
    season: number | null;
    episode: number | null;
    episodeInfo: SeasonEpisode | null;
    progress: ProgressEntry | null;
    startSec: number;
}

export type ResolveError = "not_found" | "no_file" | "no_episode";

export async function resolvePlayback(src: TitleSource, inp: ResolveInput): Promise<{ ok: true; value: Resolved } | { ok: false; error: ResolveError }> {
    const title = await src.mediaTitle(inp.kind, inp.tmdbId);
    if (!title) return { ok: false, error: "not_found" };

    if (inp.kind === "movie") {
        const versions = sortVersions(title.files);
        const file = pickFile(versions, inp.file);
        if (!file) return { ok: false, error: "no_file" };
        const progress = progressFor(title.progress, "movie");
        const durationSec = title.title.runtime ? title.title.runtime * 60 : null;
        return {
            ok: true,
            value: {
                title, file, versions, season: null, episode: null, episodeInfo: null, progress,
                startSec: resumePosition({ explicit: inp.startSec, progress, durationSec }),
            },
        };
    }

    let season = inp.season ?? null;
    let episode = inp.episode ?? null;
    if (season === null || episode === null) {
        // A specific file id without s/e: find its episode in the title's list.
        const byFile = inp.file ? title.files.find((f) => f.serverFileId === inp.file) : undefined;
        if (byFile?.season != null && byFile.episode != null) { season = byFile.season; episode = byFile.episode; }
        else if (title.nextUp) { season = title.nextUp.season; episode = title.nextUp.episode; }
        else {
            const first = firstEpisodeWithFile(title.files);
            if (!first) return { ok: false, error: "no_file" };
            season = first.season; episode = first.episode;
        }
    }
    const s = await src.season(inp.tmdbId, season).catch(() => null);
    const ep = s?.episodes.find((x) => x.episodeNumber === episode) ?? null;
    const files = ep && ep.files.length > 0 ? ep.files : episodeFiles(title.files, season, episode);
    if (files.length === 0) return { ok: false, error: ep || s ? "no_file" : "no_episode" };
    const versions = sortVersions(files);
    const file = pickFile(versions, inp.file);
    if (!file) return { ok: false, error: "no_file" };
    const progress = ep?.progress ?? progressFor(title.progress, "tv", season, episode);
    const durationSec = ep?.runtime ? ep.runtime * 60 : null;
    // Explicit `t` wins; nextUp carries its own position when the user did not pick an episode.
    const fromNextUp = inp.season == null && title.nextUp && title.nextUp.season === season && title.nextUp.episode === episode
        ? title.nextUp.positionSec : null;
    const explicit = inp.startSec ?? (fromNextUp !== null && fromNextUp > 0 ? fromNextUp : null);
    return {
        ok: true,
        value: {
            title, file, versions, season, episode, episodeInfo: ep, progress,
            startSec: resumePosition({ explicit, progress, durationSec }),
        },
    };
}

export interface NextUpInfo {
    season: number;
    episode: number;
    name: string;
    stillPath: string | null;
    fileId: string;
}

/** Next playable episode after (season, episode), or null (movies, finale, nothing local). */
export async function resolveNextUp(src: TitleSource, tmdbId: number, season: number, episode: number): Promise<NextUpInfo | null> {
    const cur = await src.season(tmdbId, season).catch(() => null);
    const later = (cur?.episodes ?? []).some((x) => x.episodeNumber > episode && x.files.length > 0);
    const following = later ? null : await src.season(tmdbId, season + 1).catch(() => null);
    const n = nextPlayable(cur?.episodes ?? [], season, episode, following?.episodes ?? null);
    return n ? { season: n.season, episode: n.episode, name: n.ep.name, stillPath: n.ep.stillPath, fileId: n.file.serverFileId } : null;
}
