"use server";

/**
 * Media Home data layer (WP11-03/04). Fan-out to every paired MMO Server,
 * merge by TMDB id, enrich with Postgres watch history. Server-heavy calls
 * (`/media/home`, `/media/title`) are memoised for 5 min per
 * user+profile+region with `unstable_cache`; the auth/DB lookups that need
 * request cookies stay outside the cache boundary.
 *
 * A server that is offline, too old (404 on `/media/*`) or slow never fails
 * the page: it lands in `errors` and the UI renders an inline notice.
 */

import { unstable_cache } from "next/cache";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, watchHistory } from "@/db/schema";
import { getActiveProfileId } from "@/lib/active-profile";
import { getAllCompanionLinks, type CompanionLinkInfo } from "@/lib/companion-library";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { isInWatchlist } from "@/actions/watchlist";
import { markWatched } from "@/actions/video-playback";
import { markUnwatched } from "@/actions/video-context";
import { mergeRows, type FanOutResult, type ServerError, type ServerResult } from "@/lib/media/aggregate";
import { normalizeRows, type WireHome, type WireTitleResponse } from "@/lib/media/normalize";
import { mergeTitleResponses } from "@/lib/media/title";
import { CURATOR_TTL_SEC, curateRows, homeRevisionHash, type CuratorNoteItem } from "@/lib/media/curator";
import { getCodaiModel, isCodaiAvailable } from "@/lib/codai/client";
import type { HomeRow, MediaKind, MediaServer, MergedTitleDetails, TitleCard } from "@/lib/media/types";

const HOME_TTL_SEC = 300;
const TIMEOUT_MS = 4000;

type LinkLite = Pick<CompanionLinkInfo, "apiUrl" | "token" | "userId" | "deviceId" | "name">;

function toServer(l: CompanionLinkInfo): MediaServer {
    return { id: l.deviceId, name: l.name, online: l.online, apiUrl: l.apiUrl, lastSeenAt: l.lastSeenAt };
}

/** Fetch `path` on each link in parallel; 404 = server too old → counted as an error, not a crash. */
async function fanOut<T>(links: LinkLite[], path: string): Promise<FanOutResult<T>> {
    const results: ServerResult<T>[] = [];
    const errors: ServerError[] = [];
    await Promise.all(links.map(async (link) => {
        try {
            const res = await fetch(`${link.apiUrl}${path}`, {
                headers: { "x-device-token": link.token, "x-user-id": link.userId },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (res.status === 404) throw new Error("outdated");
            if (!res.ok) throw new Error(`http_${res.status}`);
            results.push({ serverId: link.deviceId, name: link.name, data: (await res.json()) as T });
        } catch (e) {
            const msg = e instanceof Error ? (e.name === "TimeoutError" ? "timeout" : e.message) : String(e);
            errors.push({ serverId: link.deviceId, name: link.name, error: msg });
        }
    }));
    return { results, errors };
}

// Tokens must not become part of the cache key; the key is user+profile+region
// and the links are closed over per call (same inputs → same servers).
function cachedHome(userId: string, profileId: string, region: string, providers: number[], links: LinkLite[]) {
    const q = new URLSearchParams({ profile: profileId, region });
    if (providers.length) q.set("providers", providers.join(","));
    return unstable_cache(
        async () => {
            const { results, errors } = await fanOut<WireHome>(links, `/media/home?${q.toString()}`);
            const rows = mergeRows(results.map((r) => ({ ...r, data: normalizeRows(r.data) })));
            return { rows, errors, serverIds: results.map((r) => r.serverId) };
        },
        ["media-home", userId, profileId, region, providers.join(","), links.map((l) => l.deviceId).sort().join(",")],
        { revalidate: HOME_TTL_SEC, tags: [`media-home:${userId}`] },
    )();
}

/**
 * Codai curator (WP11-07): one model call per (user, profile, region, rows
 * hash), cached 24 h. The model closure runs inside the cache boundary; the
 * key never contains tokens. Any failure → rows unchanged, no notes.
 */
function cachedCuration(userId: string, profileId: string, region: string, rows: HomeRow[]) {
    const hash = homeRevisionHash(rows);
    return unstable_cache(
        async () => {
            const model = await getCodaiModel(userId, "fast");
            return curateRows(rows, { model });
        },
        ["media-curator", userId, profileId, region, hash],
        { revalidate: CURATOR_TTL_SEC, tags: [`media-home:${userId}`] },
    )();
}

function cachedTitle(userId: string, profileId: string, region: string, kind: MediaKind, tmdbId: number, links: LinkLite[]) {
    return unstable_cache(
        async () => fanOut<WireTitleResponse>(
            links,
            `/media/title/${kind}/${tmdbId}?profile=${encodeURIComponent(profileId)}&region=${region}`,
        ),
        ["media-title", userId, profileId, region, kind, String(tmdbId), links.map((l) => l.deviceId).sort().join(",")],
        { revalidate: HOME_TTL_SEC, tags: [`media-home:${userId}`] },
    )();
}

async function context() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    const [profileId, prefs, links] = await Promise.all([getActiveProfileId(), getWatchPrefs(), getAllCompanionLinks()]);
    return {
        userId,
        profileId: String(profileId ?? "default"),
        profileIdNum: profileId,
        region: (prefs.defaultRegion || "RO").toUpperCase().slice(0, 2),
        preferredProviders: prefs.preferredProviders.filter((n) => Number.isInteger(n) && n > 0),
        curator: prefs.curator,
        links,
        servers: links.map(toServer),
    };
}

export interface MediaHomeResult {
    servers: MediaServer[];
    rows: HomeRow[];
    errors: ServerError[];
    region: string;
    /** Curator "why" notes for the first picks (empty unless WP11-07 ran). */
    curatorNotes: CuratorNoteItem[];
    /** Epoch ms when the result was assembled — for relative "last seen" labels (no Date.now() in render). */
    now: number;
}

/** Postgres `watch_history` (per profile) → Continue cards for movies we know the TMDB id of. */
async function continueFromHistory(profileId: number | null): Promise<TitleCard[]> {
    if (!profileId) return [];
    const rows = await db.select({
        tmdbId: movies.tmdbId, title: movies.title, year: movies.year, poster: movies.posterPath,
        backdrop: movies.backdropPath, rating: movies.rating, overview: movies.overview,
        pos: watchHistory.positionSec, dur: watchHistory.durationSec,
    }).from(watchHistory)
        .innerJoin(movies, eq(movies.id, watchHistory.movieId))
        .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.completed, false), isNotNull(movies.tmdbId)))
        .orderBy(desc(watchHistory.watchedAt))
        .limit(15);
    return rows.map((r) => ({
        kind: "movie" as const, tmdbId: r.tmdbId!, title: r.title, year: r.year, poster: r.poster, backdrop: r.backdrop,
        rating: r.rating, overview: r.overview, inLibrary: true, sources: [],
        progress: r.dur && r.dur > 0 ? Math.min(1, r.pos / r.dur) : null,
    }));
}

export async function getMediaHome(): Promise<MediaHomeResult | null> {
    const ctx = await context();
    if (!ctx) return null;
    const online = ctx.links.filter((l) => l.online);
    const offlineErrors: ServerError[] = ctx.links.filter((l) => !l.online)
        .map((l) => ({ serverId: l.deviceId, name: l.name, error: "offline" }));
    const [home, cont] = await Promise.all([
        online.length ? cachedHome(ctx.userId, ctx.profileId, ctx.region, ctx.preferredProviders, online) : Promise.resolve({ rows: [] as HomeRow[], errors: [] as ServerError[], serverIds: [] as string[] }),
        continueFromHistory(ctx.profileIdNum).catch(() => [] as TitleCard[]),
    ]);
    let rows = home.rows;
    if (cont.length > 0) {
        const existing = rows.find((r) => r.id === "continue");
        const webRow: HomeRow = { id: "continue", title: { ro: "Continuă vizionarea", en: "Continue watching" }, kind: "mixed", items: cont };
        rows = existing
            ? mergeRows([{ serverId: "web", name: "web", data: [webRow] }, { serverId: "merged", name: "merged", data: [existing] }])
                .concat(rows.filter((r) => r.id !== "continue"))
            : [webRow, ...rows];
    }
    // Home rows only flag `inLibrary`; attribute a source to every responding server that owns it
    // so chips can filter. The title page resolves the exact files.
    for (const row of rows) {
        for (const it of row.items) {
            if (it.inLibrary && (!it.sources || it.sources.length === 0)) {
                it.sources = home.serverIds.map((id) => {
                    const l = ctx.links.find((x) => x.deviceId === id)!;
                    return { serverId: id, serverName: l.name };
                });
            }
        }
    }
    let curatorNotes: CuratorNoteItem[] = [];
    if (ctx.curator && rows.length > 0 && isCodaiAvailable()) {
        const curated = await cachedCuration(ctx.userId, ctx.profileId, ctx.region, rows).catch(() => null);
        if (curated) { rows = curated.rows; curatorNotes = curated.notes; }
    }
    return { servers: ctx.servers, rows, errors: [...home.errors, ...offlineErrors], region: ctx.region, curatorNotes, now: Date.now() };
}

export async function getMediaTitle(kind: MediaKind, tmdbId: number): Promise<(MergedTitleDetails & { servers: MediaServer[]; preferredProviders: number[] }) | null> {
    const ctx = await context();
    if (!ctx) return null;
    const online = ctx.links.filter((l) => l.online);
    if (online.length === 0) return null;
    const { results, errors } = await cachedTitle(ctx.userId, ctx.profileId, ctx.region, kind, tmdbId, online);
    const merged = mergeTitleResponses(results, errors);
    return merged ? { ...merged, servers: ctx.servers, preferredProviders: ctx.preferredProviders } : null;
}

export interface MediaServerStatus extends MediaServer {
    configured: boolean | null;
    error: string | null;
}

export async function getMediaServersStatus(): Promise<MediaServerStatus[]> {
    const ctx = await context();
    if (!ctx) return [];
    const { results, errors } = await fanOut<{ configured?: boolean; tmdb?: boolean }>(ctx.links.filter((l) => l.online), "/media/status");
    return ctx.servers.map((s) => {
        const ok = results.find((r) => r.serverId === s.id);
        const err = errors.find((e) => e.serverId === s.id);
        return { ...s, configured: ok ? !!(ok.data.configured ?? ok.data.tmdb) : null, error: err?.error ?? (s.online ? null : "offline") };
    });
}

export interface LocalTitleState {
    /** Postgres `movies.id` / `tv_shows.id` when the title is indexed in the web DB. */
    localId: number | null;
    inWatchlist: boolean;
    watched: boolean;
    hidden: boolean;
}

/** Web-side state for the title page actions (watchlist / watched / hidden). */
export async function getLocalTitleState(kind: MediaKind, tmdbId: number): Promise<LocalTitleState> {
    const session = await auth();
    const userId = session?.user?.id;
    const none: LocalTitleState = { localId: null, inWatchlist: false, watched: false, hidden: false };
    if (!userId) return none;
    const [prefs, profileId] = await Promise.all([getWatchPrefs(), getActiveProfileId()]);
    const hidden = (kind === "movie" ? prefs.hiddenMovieTmdbIds : prefs.hiddenShowTmdbIds).includes(tmdbId);
    const local = kind === "movie"
        ? await db.select({ id: movies.id }).from(movies).where(and(eq(movies.userId, userId), eq(movies.tmdbId, tmdbId))).limit(1)
        : await db.select({ id: tvShows.id }).from(tvShows).where(and(eq(tvShows.userId, userId), eq(tvShows.tmdbId, tmdbId))).limit(1);
    const localId = local[0]?.id ?? null;
    if (!localId) return { ...none, hidden };
    const [inWatchlist, hist] = await Promise.all([
        isInWatchlist(kind === "movie" ? "movie" : "show", localId),
        kind === "movie" && profileId
            ? db.select({ completed: watchHistory.completed }).from(watchHistory)
                .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.movieId, localId))).limit(1)
            : Promise.resolve([] as Array<{ completed: boolean }>),
    ]);
    return { localId, inWatchlist, watched: hist[0]?.completed ?? false, hidden };
}

/** Toggle watched for a locally indexed movie (shows are per-episode; no-op). */
export async function setTitleWatched(kind: MediaKind, localId: number, watched: boolean) {
    if (kind !== "movie") return { ok: false as const, error: "movies-only" as const };
    const r = watched ? await markWatched({ movieId: localId }) : await markUnwatched({ movieId: localId });
    return "error" in r ? { ok: false as const, error: r.error } : { ok: true as const };
}
