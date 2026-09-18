import { auth } from "@/auth";
import { db } from "@/db";
import { videoFiles, movies, tvEpisodes, tvShows, watchHistory, watchProfiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getPlaybackHandle, companionHlsUrl, companionDirectUrl, canBrowserDirectPlay } from "@/lib/companion-video";
import { getCompanionLinkForDevice } from "@/lib/companion-library";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PlayerHost } from "./_player-host";
import { getActiveProfileId } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

/**
 * Media Home entry (WP11-04): `/watch/play/<companionFileId>?server=<deviceId>&cid=<companionFileId>`.
 * The MMO Server already told us its own file id, so skip the Postgres
 * `video_files` lookup and build the stream URLs for that device directly.
 * Progress is not persisted (no DB row to attach it to) — the server-side
 * `/media/progress` sync (WP10-06) covers it.
 */
async function playCompanionFile(deviceId: string, cid: string, q: string, startSec: number) {
    const link = await getCompanionLinkForDevice(deviceId);
    if (!link) return null;
    const info = await fetch(`${link.apiUrl}/video/file/${encodeURIComponent(cid)}/info`, {
        headers: { "X-Device-Token": link.token, "X-User-Id": link.userId },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as
        { parsed?: { title?: string; year?: number | null }; container?: string | null; videoCodec?: string | null; audioCodec?: string | null; durationSec?: number | null } | null;
    const hlsUrl = companionHlsUrl(link.apiUrl, cid, q, link.token, link.userId, startSec);
    const directUrl = canBrowserDirectPlay(info?.container, info?.videoCodec, info?.audioCodec)
        ? companionDirectUrl(link.apiUrl, cid, link.token, link.userId)
        : null;
    return (
        <main style={{ width: "100vw", height: "100vh", background: "var(--background)" }}>
            <PlayerHost
                hlsUrl={hlsUrl}
                directUrl={directUrl}
                title={info?.parsed?.title ?? "Video"}
                subtitle={info?.parsed?.year ? String(info.parsed.year) : undefined}
                durationHint={info?.durationSec ?? null}
                startSec={startSec}
            />
        </main>
    );
}

export default async function PlayPage({ params, searchParams }: {
    params: Promise<{ fileId: string }>;
    searchParams: Promise<{ q?: string; start?: string; server?: string; cid?: string }>;
}) {
    const { fileId } = await params;
    const { q = "original", start = "0", server, cid } = await searchParams;
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return notFound();

    if (server && cid) {
        const direct = await playCompanionFile(server, cid, q, parseInt(start, 10) || 0);
        if (direct) return direct;
        return notFound();
    }

    const activeProfileId = await getActiveProfileId();

    const dbFile = await db.select().from(videoFiles)
        .where(and(eq(videoFiles.userId, userId), eq(videoFiles.id, Number(fileId))))
        .limit(1).then(r => r[0]);
    if (!dbFile) return notFound();

    let title = "Video";
    let subtitle: string | undefined;
    let poster: string | null = null;
    if (dbFile.movieId) {
        const m = await db.select().from(movies).where(eq(movies.id, dbFile.movieId)).limit(1).then(r => r[0]);
        if (m) {
            title = m.title;
            poster = m.posterPath ? `https://image.tmdb.org/t/p/w500${m.posterPath}` : null;
            if (m.year) subtitle = String(m.year);
        }
    } else if (dbFile.episodeId) {
        const e = await db.select().from(tvEpisodes).where(eq(tvEpisodes.id, dbFile.episodeId)).limit(1).then(r => r[0]);
        if (e) {
            const s = await db.select().from(tvShows).where(eq(tvShows.id, e.showId)).limit(1).then(r => r[0]);
            title = s?.title ?? "Episode";
            poster = s?.posterPath ? `https://image.tmdb.org/t/p/w500${s.posterPath}` : null;
            subtitle = `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}${e.title ? ` — ${e.title}` : ""}`;
        }
    }

    const handle = await getPlaybackHandle();
    const t = await getTranslations("watch.play");
    if (!handle) {
        return (
            <main className="px-8 py-16 text-center">
                <h1>{t("companionOffline")}</h1>
                <p style={{ color: "var(--watch-fg-dim)" }}>{t("companionOfflineHint")}</p>
            </main>
        );
    }

    // The companion stores the file by its short hash. The DB stores the
    // absolute path. We need the hash for the URL — derive it client-side
    // would be unsafe (hash uses companion-internal scheme). So we make a
    // round-trip: ask the companion to scan once, then index by path. As
    // a simpler shortcut for now, the companion fileId == DB id won't
    // work — we'd need a "get fileId by path" endpoint. Build it inline.
    const fileIdResp = await fetch(`${handle.apiUrl}/video/lookup?path=${encodeURIComponent(dbFile.path)}`, {
        headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!fileIdResp || !fileIdResp.ok) {
        return (
            <main className="px-8 py-16 text-center">
                <h1>{t("fileMissing")}</h1>
                <p style={{ color: "var(--watch-fg-dim)" }}>{t("fileMissingHint")}</p>
                <p style={{ color: "var(--watch-fg-dim)", fontFamily: "monospace", fontSize: ".8rem", marginTop: "1rem" }}>{dbFile.path}</p>
            </main>
        );
    }
    const lookup = await fileIdResp.json() as { fileId: string };

    const startSec = parseInt(start, 10) || 0;
    const hlsUrl = companionHlsUrl(handle.apiUrl, lookup.fileId, q, handle.token, handle.userId, startSec);
    const directUrl = canBrowserDirectPlay(dbFile.container, dbFile.videoCodec, dbFile.audioCodec)
        ? companionDirectUrl(handle.apiUrl, lookup.fileId, handle.token, handle.userId)
        : null;

    // Resume from history
    const prof = activeProfileId ? await db.select().from(watchProfiles).where(eq(watchProfiles.id, activeProfileId)).limit(1).then(r => r[0] ?? null) : null;
    const hist = prof ? await db.select().from(watchHistory).where(and(
        eq(watchHistory.profileId, prof.id),
        dbFile.movieId ? eq(watchHistory.movieId, dbFile.movieId) : eq(watchHistory.episodeId, dbFile.episodeId!),
    )).limit(1).then(r => r[0] ?? null) : null;
    const resumeAt = startSec || (hist && !hist.completed ? hist.positionSec : 0);

    return (
        <main style={{ width: "100vw", height: "100vh", background: "#000" }}>
            <PlayerHost
                hlsUrl={hlsUrl}
                directUrl={directUrl}
                poster={poster}
                title={title}
                subtitle={subtitle}
                durationHint={dbFile.durationSec}
                startSec={resumeAt}
                movieId={dbFile.movieId}
                episodeId={dbFile.episodeId}
                fileId={dbFile.id}
            />
        </main>
    );
}
