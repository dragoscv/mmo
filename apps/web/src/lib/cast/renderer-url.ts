/**
 * Renderer-facing media URLs (server-only).
 *
 * A Chromecast / DLNA TV / HA media player fetches the stream itself, so
 * the URL must be reachable from the renderer: the companion's announced
 * LAN URL (`devices.lan_url`, same source as /api/devices/peers) — never
 * the Cloudflare tunnel (Cast DMR would work, DLNA needs plain http and
 * both would leave the LAN) — with `?t=&u=` query auth.
 *
 * `pickVideoSource` / `buildTrackRendererUrl` are pure and unit-tested;
 * the exported `buildRendererMediaUrls` does the DB + companion lookups.
 */

import "server-only";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices, videoFiles, movies, tvEpisodes, tvShows } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCompanionLink, getCompanionLinkForDevice } from "@/lib/companion-library";
import { companionDirectUrl, companionHlsUrl, companionEmbeddedSubUrl } from "@/lib/companion-video";
import { resolveStreamSource } from "@/lib/cloud-library";
import { pickVideoSource, buildTrackRendererUrl, mimeForPath, type RendererKind } from "./renderer-url-pure";

export type { RendererKind } from "./renderer-url-pure";

export interface RendererMediaUrls {
    url: string;
    mime: string;
    title: string;
    subtitle?: string;
    poster?: string | null;
    /** WebVTT subtitle tracks (companion `/video/subs/:fileId/:idx`). */
    subtitles: Array<{ src: string; lang: string; label: string }>;
    /** Whether `url` is HLS (Cast DMR ok, DLNA usually not). */
    hls: boolean;
}

export type RendererMediaRef =
    | { type: "video"; fileId: number }
    | { type: "track"; trackId: number };

async function lanBaseFor(deviceId: string, fallback: string): Promise<string> {
    const row = await db.select({ lanUrl: devices.lanUrl }).from(devices).where(eq(devices.id, deviceId)).limit(1).then((r) => r[0]);
    return (row?.lanUrl || fallback).replace(/\/+$/, "");
}

/** Build renderer-reachable URLs for a video file or a music track. Returns
 *  null when unauthenticated, the media is unknown, or no companion holds it. */
export async function buildRendererMediaUrls(ref: RendererMediaRef, kind: RendererKind): Promise<RendererMediaUrls | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    if (ref.type === "track") {
        const source = await resolveStreamSource(ref.trackId);
        if (!source?.filepath) return null;
        const link = await getCompanionLinkForDevice(source.deviceId);
        if (!link) return null;
        const base = await lanBaseFor(source.deviceId, link.apiUrl);
        const filename = source.filepath.split(/[\\/]/).pop() ?? `track-${ref.trackId}`;
        return {
            url: buildTrackRendererUrl(base, source.filepath, link.token, link.userId),
            mime: mimeForPath(source.filepath),
            title: filename.replace(/\.[a-z0-9]+$/i, ""),
            subtitles: [],
            hls: false,
        };
    }

    const dbFile = await db.select().from(videoFiles)
        .where(and(eq(videoFiles.userId, userId), eq(videoFiles.id, ref.fileId)))
        .limit(1).then((r) => r[0]);
    if (!dbFile) return null;

    const link = await getCompanionLink();
    if (!link) return null;
    const lookupResp = await fetch(`${link.apiUrl}/video/lookup?path=${encodeURIComponent(dbFile.path)}`, {
        headers: { "X-Device-Token": link.token, "X-User-Id": link.userId },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!lookupResp?.ok) return null;
    const { fileId } = (await lookupResp.json()) as { fileId: string };
    const base = await lanBaseFor(link.deviceId, link.apiUrl);

    let title = dbFile.path.split(/[\\/]/).pop() ?? "Video";
    let subtitle: string | undefined;
    let poster: string | null = null;
    if (dbFile.movieId) {
        const m = await db.select().from(movies).where(eq(movies.id, dbFile.movieId)).limit(1).then((r) => r[0]);
        if (m) {
            title = m.title ?? title;
            if (m.year) subtitle = String(m.year);
            poster = m.posterPath ? `https://image.tmdb.org/t/p/w500${m.posterPath}` : null;
        }
    } else if (dbFile.episodeId) {
        const e = await db.select().from(tvEpisodes).where(eq(tvEpisodes.id, dbFile.episodeId)).limit(1).then((r) => r[0]);
        if (e) {
            const s = await db.select().from(tvShows).where(eq(tvShows.id, e.showId)).limit(1).then((r) => r[0]);
            title = s?.title ?? title;
            subtitle = `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}${e.title ? ` — ${e.title}` : ""}`;
            poster = s?.posterPath ? `https://image.tmdb.org/t/p/w500${s.posterPath}` : null;
        }
    }

    const choice = pickVideoSource({ container: dbFile.container, videoCodec: dbFile.videoCodec, audioCodec: dbFile.audioCodec }, kind);
    const url = choice.hls
        ? companionHlsUrl(base, fileId, "original", link.token, link.userId)
        : companionDirectUrl(base, fileId, link.token, link.userId);

    const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);
    const rawSubs = Array.isArray(dbFile.subtitleTracks)
        ? (dbFile.subtitleTracks as Array<{ index?: number; codec?: string; lang?: string | null; title?: string | null }>)
        : [];
    const subtitles = [...rawSubs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => TEXT_SUB_CODECS.has((s.codec ?? "").toLowerCase()))
        .map(({ s, i }) => ({
            src: companionEmbeddedSubUrl(base, fileId, i, link.token, link.userId),
            lang: (s.lang ?? "und").toLowerCase(),
            label: [(s.lang ?? "und").toUpperCase(), s.title].filter(Boolean).join(" · "),
        }));

    return { url, mime: choice.mime, title, subtitle, poster, subtitles, hls: choice.hls };
}
