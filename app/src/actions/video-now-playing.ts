"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { videoFiles, movies, tvEpisodes, tvShows, watchHistory, watchProfiles } from "@/db/schema";import { and, eq } from "drizzle-orm";
import {
    getPlaybackHandle,
    companionHlsUrl,
    companionDirectUrl,
    companionEmbeddedSubUrl,
    canBrowserDirectPlay,
} from "@/lib/companion-video";
import { getActiveProfileId } from "@/lib/active-profile";
import type { VideoMedia } from "@/components/player-context";

/** Optional playback-mode override the user can pick from the UI dropdown.
 *  - `auto`            : current default heuristic (companion picks the
 *                        cheapest realtime path based on probed codecs).
 *  - `direct`          : skip HLS entirely, serve the file (or its
 *                        `.mmo.mp4` sidecar) via HTTP range. Zero ffmpeg.
 *  - `remux`           : force HLS with `-c:v copy -c:a copy` to fmp4.
 *  - `audio-transcode` : force HLS with video copy + AAC stereo.
 *  - `full-transcode`  : force full NVENC re-encode (last-resort path).
 */
export type PlaybackMode = "auto" | "direct" | "remux" | "audio-transcode" | "full-transcode";

/** Server action: resolve a `videoFiles.id` into a serializable `VideoMedia`
 *  that the client `<PlayerProvider>` can hand to the canonical
 *  `<VideoPlayer>` mount. Returns `null` when the user is unauthenticated,
 *  the file doesn't exist, the companion is offline, or the file isn't
 *  registered with the companion. */
export async function resolveVideoForPlayback(
    fileId: number,
    mode: PlaybackMode = "auto",
): Promise<VideoMedia | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    const dbFile = await db.select().from(videoFiles)
        .where(and(eq(videoFiles.userId, userId), eq(videoFiles.id, fileId)))
        .limit(1).then(r => r[0]);
    if (!dbFile) return null;

    let title = "Video";
    let subtitle: string | undefined;
    let poster: string | null = null;
    let subtitleQuery: VideoMedia["subtitleQuery"];
    let showId: number | null = null;
    if (dbFile.movieId) {
        const m = await db.select().from(movies).where(eq(movies.id, dbFile.movieId)).limit(1).then(r => r[0]);
        if (m) {
            title = m.title ?? "Movie";
            poster = m.posterPath ? `https://image.tmdb.org/t/p/w500${m.posterPath}` : null;
            if (m.year) subtitle = String(m.year);
            subtitleQuery = {
                title: m.title ?? undefined,
                tmdbId: m.tmdbId ?? undefined,
                imdbId: m.imdbId ?? undefined,
                kind: "movie",
            };
        }
    } else if (dbFile.episodeId) {
        const e = await db.select().from(tvEpisodes).where(eq(tvEpisodes.id, dbFile.episodeId)).limit(1).then(r => r[0]);
        if (e) {
            const s = await db.select().from(tvShows).where(eq(tvShows.id, e.showId)).limit(1).then(r => r[0]);
            showId = e.showId;
            title = s?.title ?? "Episode";
            poster = s?.posterPath ? `https://image.tmdb.org/t/p/w500${s.posterPath}` : null;
            subtitle = `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}${e.title ? ` — ${e.title}` : ""}`;
            subtitleQuery = {
                title: s?.title,
                tmdbId: s?.tmdbId ?? undefined,
                imdbId: s?.imdbId ?? undefined,
                kind: "tv",
                season: e.seasonNumber,
                episode: e.episodeNumber,
            };
        }
    }

    const handle = await getPlaybackHandle();
    if (!handle) {
        console.error("[resolveVideoForPlayback] no companion handle (offline or not linked)");
        return null;
    }

    // Companion stores files by short hash; the DB stores absolute path.
    // Look up the hash via the companion's path-indexed endpoint.
    const lookupResp = await fetch(
        `${handle.apiUrl}/video/lookup?path=${encodeURIComponent(dbFile.path)}`,
        {
            headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
        },
    ).catch((err) => {
        console.error("[resolveVideoForPlayback] companion lookup fetch failed:", err?.message ?? err);
        return null;
    });
    if (!lookupResp) return null;
    if (!lookupResp.ok) {
        const body = await lookupResp.text().catch(() => "<no body>");
        console.error(`[resolveVideoForPlayback] companion lookup ${lookupResp.status} for path=${dbFile.path} body=${body.slice(0, 200)}`);
        return null;
    }
    const lookup = await lookupResp.json() as { fileId: string };

    // Resume from history (active profile)
    const activeProfileId = await getActiveProfileId();
    const hist = activeProfileId
        ? await db.select().from(watchHistory).where(and(
            eq(watchHistory.profileId, activeProfileId),
            dbFile.movieId ? eq(watchHistory.movieId, dbFile.movieId) : eq(watchHistory.episodeId, dbFile.episodeId!),
        )).limit(1).then(r => r[0] ?? null)
        : null;
    const startSec = (hist && !hist.completed) ? hist.positionSec : 0;

    const hlsUrlBase = companionHlsUrl(handle.apiUrl, lookup.fileId, "original", handle.token, handle.userId, startSec);
    // The companion HLS endpoint accepts `?mode=remux|audio-transcode|full-transcode`
    // to bypass the per-request capability heuristic.
    const hlsUrlWithMode = (m: "remux" | "audio-transcode" | "full-transcode") => {
        const u = new URL(hlsUrlBase);
        u.searchParams.set("mode", m);
        return u.toString();
    };
    const directOnly = companionDirectUrl(handle.apiUrl, lookup.fileId, handle.token, handle.userId);

    let hlsUrl: string | null;
    let directUrl: string | null;
    if (mode === "direct") {
        directUrl = directOnly;
        hlsUrl = null;
        // If a previous "auto" / "remux" attempt left an HLS session
        // alive on the companion, it's now pointless burning CPU on
        // segments nobody will fetch. Tear it down.
        void fetch(`${handle.apiUrl}/video/stream/${encodeURIComponent(lookup.fileId)}/pause`, {
            method: "POST",
            headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
            signal: AbortSignal.timeout(2000),
        }).catch(() => undefined);
    } else if (mode === "remux" || mode === "audio-transcode" || mode === "full-transcode") {
        directUrl = null;
        hlsUrl = hlsUrlWithMode(mode);
    } else {
        // auto
        hlsUrl = hlsUrlBase;
        directUrl = canBrowserDirectPlay(dbFile.container, dbFile.videoCodec, dbFile.audioCodec)
            ? directOnly
            : null;
    }
    const thumbsVttUrl = `${handle.apiUrl}/video/thumbs/${encodeURIComponent(lookup.fileId)}/thumbs.vtt?t=${encodeURIComponent(handle.token)}&u=${encodeURIComponent(handle.userId)}`;

    // Best-effort intro detection — never blocks playback.
    // Prefer cached values on the episode row; fall back to companion.
    let introMarker: { start: number; end: number } | undefined;
    let chapters: Array<{ start: number; title: string }> | undefined;
    let recapMarker: { start: number; end: number } | undefined;
    let creditsStartSec: number | undefined;

    // The intro/recap/credits/loudness/thumbs endpoints all spawn an
    // ffmpeg process on the companion (silence detect, ebur128, sprite
    // generation, …). For movies we have no cache yet, so they re-run
    // on every play. When the user explicitly picks "direct" they want
    // *zero* CPU on the companion — honor that and skip all extras.
    const skipExtras = mode === "direct";
    let cachedEpisode: typeof tvEpisodes.$inferSelect | null = null;
    if (!skipExtras && dbFile.episodeId) {
        cachedEpisode = await db.select().from(tvEpisodes).where(eq(tvEpisodes.id, dbFile.episodeId)).limit(1).then((r) => r[0] ?? null);
        if (cachedEpisode?.introStartSec != null && cachedEpisode.introEndSec != null) {
            introMarker = { start: cachedEpisode.introStartSec, end: cachedEpisode.introEndSec };
        }
        if (cachedEpisode?.recapStartSec != null && cachedEpisode.recapEndSec != null) {
            recapMarker = { start: cachedEpisode.recapStartSec, end: cachedEpisode.recapEndSec };
        }
        if (cachedEpisode?.creditsStartSec != null) creditsStartSec = cachedEpisode.creditsStartSec;
    }

    if (!skipExtras) try {
        const fetches: Array<Promise<Response>> = [];
        const askIntro = !introMarker;
        const askRecap = !recapMarker;
        if (askIntro) {
            fetches.push(fetch(`${handle.apiUrl}/video/intro/${encodeURIComponent(lookup.fileId)}`, {
                headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
                signal: AbortSignal.timeout(3500),
            }));
        }
        fetches.push(fetch(`${handle.apiUrl}/video/chapters/${encodeURIComponent(lookup.fileId)}`, {
            headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
            signal: AbortSignal.timeout(3500),
        }));
        if (askRecap) {
            fetches.push(fetch(`${handle.apiUrl}/video/recap/${encodeURIComponent(lookup.fileId)}`, {
                headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
                signal: AbortSignal.timeout(3500),
            }));
        }
        const resps = await Promise.all(fetches);
        let i = 0;
        if (askIntro) {
            const introResp = resps[i++];
            if (introResp.ok) {
                const data = await introResp.json() as { start?: number; end?: number };
                if (typeof data.start === "number" && typeof data.end === "number" && data.end > data.start) {
                    introMarker = { start: data.start, end: data.end };
                    if (dbFile.episodeId) {
                        await db.update(tvEpisodes)
                            .set({ introStartSec: data.start, introEndSec: data.end })
                            .where(eq(tvEpisodes.id, dbFile.episodeId));
                    }
                }
            }
        }
        const chaptersResp = resps[i++];
        if (chaptersResp.ok) {
            const data = await chaptersResp.json() as { chapters?: Array<{ start: number; title: string }> };
            if (Array.isArray(data.chapters) && data.chapters.length > 0) {
                chapters = data.chapters;
                if (creditsStartSec == null) {
                    const credits = chapters.find((c) => /credits|end\s*card|outro/i.test(c.title));
                    if (credits) {
                        creditsStartSec = credits.start;
                        if (dbFile.episodeId) {
                            await db.update(tvEpisodes)
                                .set({ creditsStartSec: credits.start })
                                .where(eq(tvEpisodes.id, dbFile.episodeId));
                        }
                    }
                }
            }
        }
        if (askRecap) {
            const recapResp = resps[i++];
            if (recapResp.ok) {
                const data = await recapResp.json() as { start?: number; end?: number };
                if (typeof data.start === "number" && typeof data.end === "number" && data.end > data.start) {
                    recapMarker = { start: data.start, end: data.end };
                    if (dbFile.episodeId) {
                        await db.update(tvEpisodes)
                            .set({ recapStartSec: data.start, recapEndSec: data.end })
                            .where(eq(tvEpisodes.id, dbFile.episodeId));
                    }
                }
            }
        }
    } catch { /* offline or timeout — skip */ }

    // Separate slower probe: credits silence detection + loudness analysis.
    // Cache lookups happen first; only call companion if missing.
    let loudnessGainDb: number | undefined;
    if (dbFile.loudnessGainDb != null) loudnessGainDb = dbFile.loudnessGainDb;
    const askCredits = !skipExtras && creditsStartSec == null;
    const askLoudness = !skipExtras && loudnessGainDb == null;
    if (askCredits || askLoudness) {
        try {
            const slowFetches: Array<Promise<Response>> = [];
            if (askCredits) {
                slowFetches.push(fetch(`${handle.apiUrl}/video/credits/${encodeURIComponent(lookup.fileId)}`, {
                    headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
                    signal: AbortSignal.timeout(8000),
                }));
            }
            if (askLoudness) {
                slowFetches.push(fetch(`${handle.apiUrl}/video/loudness/${encodeURIComponent(lookup.fileId)}`, {
                    headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
                    signal: AbortSignal.timeout(15000),
                }));
            }
            const slowResps = await Promise.all(slowFetches);
            let j = 0;
            if (askCredits) {
                const cResp = slowResps[j++];
                if (cResp.ok) {
                    const data = await cResp.json() as { start?: number };
                    if (typeof data.start === "number" && data.start > 0) {
                        creditsStartSec = data.start;
                        if (dbFile.episodeId) {
                            await db.update(tvEpisodes)
                                .set({ creditsStartSec: data.start })
                                .where(eq(tvEpisodes.id, dbFile.episodeId));
                        }
                    }
                }
            }
            if (askLoudness) {
                const lResp = slowResps[j++];
                if (lResp.ok) {
                    const data = await lResp.json() as { integrated?: number; gainDb?: number };
                    if (typeof data.integrated === "number" && typeof data.gainDb === "number") {
                        loudnessGainDb = data.gainDb;
                        await db.update(videoFiles)
                            .set({ loudnessIntegrated: data.integrated, loudnessGainDb: data.gainDb })
                            .where(eq(videoFiles.id, dbFile.id));
                    }
                }
            }
        } catch { /* skip */ }
    }

    // Audio tracks from ffprobe metadata stored on the videoFiles row.
    const audioTracks = Array.isArray(dbFile.audioTracks)
        ? (dbFile.audioTracks as Array<{ index?: number; lang?: string; label?: string; codec?: string }>)
            .map((t, i) => ({ index: t.index ?? i, lang: t.lang, label: t.label, codec: t.codec }))
        : undefined;

    // Embedded subtitle tracks → text-only, mapped to companion WebVTT
    // extraction URLs. The 0-based index here is the position within
    // subtitle streams (what ffmpeg's `-map 0:s:N` expects), derived by
    // sorting on the absolute ffmpeg stream index from the probe.
    const TEXT_SUB_CODECS = new Set([
        "subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text",
    ]);
    const rawSubs = Array.isArray(dbFile.subtitleTracks)
        ? (dbFile.subtitleTracks as Array<{ index?: number; codec?: string; lang?: string | null; title?: string | null; forced?: boolean }>)
        : [];
    const orderedSubs = [...rawSubs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const embeddedSubtitles = orderedSubs
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => TEXT_SUB_CODECS.has((s.codec ?? "").toLowerCase()))
        .map(({ s, i }) => {
            const lang = (s.lang ?? "und").toLowerCase();
            const sdh = /sdh|hearing.impaired|\bhi\b|\bcc\b/i.test(s.title ?? "");
            const forced = !!s.forced || /forced/i.test(s.title ?? "");
            const parts: string[] = [lang.toUpperCase()];
            if (sdh) parts.push("SDH");
            if (forced) parts.push("Forced");
            if (s.title) parts.push(s.title);
            return {
                src: companionEmbeddedSubUrl(handle.apiUrl, lookup.fileId, i, handle.token, handle.userId),
                lang,
                label: parts.join(" \u00b7 "),
                sdh,
                forced,
                codec: s.codec,
            };
        });

    return {
        fileId: dbFile.id,
        movieId: dbFile.movieId,
        episodeId: dbFile.episodeId,
        showId,
        title,
        subtitle,
        poster,
        hlsUrl: hlsUrl ?? "",
        directUrl,
        durationSec: dbFile.durationSec ?? null,
        startSec,
        subtitleQuery,
        introMarker,
        chapters,
        thumbsVttUrl: skipExtras ? undefined : thumbsVttUrl,
        recapMarker,
        creditsStartSec,
        loudnessGainDb,
        audioTracks,
        embeddedSubtitles: embeddedSubtitles.length ? embeddedSubtitles : undefined,
    };
}

/** Resolve a list of `videoFiles.id`s in order, skipping ones that fail. */
export async function resolveVideoQueue(fileIds: number[]): Promise<VideoMedia[]> {
    const out: VideoMedia[] = [];
    for (const id of fileIds) {
        const v = await resolveVideoForPlayback(id);
        if (v) out.push(v);
    }
    return out;
}
