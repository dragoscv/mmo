/**
 * `/api/media/sync` — MMO Server ⇄ web progress + plays (WP11, tracker §10).
 *
 * POST: the server (`server/src/media/sync-client.ts`) pushes
 *   `{deviceId, revision, progress: ProgressEntry[], plays: TrackPlay[]}` with
 *   `Authorization: Bearer <deviceToken>`. We upsert `watch_history`
 *   (last-writer-wins on `watched_at`), insert `track_plays` (dedupe on
 *   user+track+playedAt), bump `media_sync_state` and invalidate the
 *   Media Home cache for the owning user.
 * GET `?since=<iso|ms>`: web-side progress written after `since`, in the
 *   server's `ProgressEntry` shape, so a server (and through it the TVs)
 *   can pull what the browser recorded.
 *
 * Titles the web has never indexed (no `movies`/`tv_shows` row for that
 * TMDB id) are counted in `skipped` — there is no FK target for them.
 */

import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { mediaSyncState, movies, trackPlays, tracks, tvEpisodes, tvShows, watchHistory, watchProfiles } from "@/db/schema";
import { requireRate } from "@/lib/api-guard";
import { findDeviceByToken } from "@/lib/device-token";
import {
    dedupePlays,
    dedupeProgress,
    fraction,
    parseTrackKey,
    resolveProfileId,
    shouldApply,
    syncBodySchema,
    toServerProgress,
    type ProgressEntry,
} from "@/lib/media/sync-map";

function bearer(req: NextRequest): string | null {
    const h = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m?.[1]?.trim() || null;
}

async function authDevice(req: NextRequest) {
    const token = bearer(req);
    if (!token) return null;
    return findDeviceByToken(token);
}

async function ownedProfiles(userId: string): Promise<{ ids: number[]; fallback: number | null }> {
    const rows = await db.select({ id: watchProfiles.id }).from(watchProfiles)
        .where(eq(watchProfiles.userId, userId)).orderBy(asc(watchProfiles.sortOrder), asc(watchProfiles.id));
    let ids = rows.map((r) => r.id);
    if (ids.length === 0) {
        const inserted = await db.insert(watchProfiles).values({ userId, name: "Eu", color: "#7c3aed", sortOrder: 0 })
            .returning({ id: watchProfiles.id });
        ids = inserted.map((r) => r.id);
    }
    return { ids, fallback: ids[0] ?? null };
}

async function applyProgress(userId: string, entries: ProgressEntry[], profiles: { ids: number[]; fallback: number | null }) {
    let applied = 0;
    let skipped = 0;
    for (const e of dedupeProgress(entries)) {
        const profileId = resolveProfileId(e.profileId, profiles.ids, profiles.fallback);
        if (!profileId) { skipped++; continue; }
        const at = new Date(e.updatedAt);
        const progress = fraction(e.positionSec, e.durationSec);
        const values = { positionSec: e.positionSec, durationSec: e.durationSec || null, progress, completed: e.completed, watchedAt: at };

        if (e.kind === "movie") {
            const [m] = await db.select({ id: movies.id }).from(movies)
                .where(and(eq(movies.userId, userId), eq(movies.tmdbId, e.tmdbId))).limit(1);
            if (!m) { skipped++; continue; }
            const [existing] = await db.select({ id: watchHistory.id, watchedAt: watchHistory.watchedAt }).from(watchHistory)
                .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.movieId, m.id))).limit(1);
            if (existing) {
                if (!shouldApply(e.updatedAt, existing.watchedAt)) { skipped++; continue; }
                await db.update(watchHistory).set(values).where(eq(watchHistory.id, existing.id));
            } else {
                await db.insert(watchHistory).values({ profileId, kind: "movie", movieId: m.id, ...values });
            }
            applied++;
            continue;
        }

        const [show] = await db.select({ id: tvShows.id }).from(tvShows)
            .where(and(eq(tvShows.userId, userId), eq(tvShows.tmdbId, e.tmdbId))).limit(1);
        if (!show) { skipped++; continue; }
        const [ep] = await db.select({ id: tvEpisodes.id }).from(tvEpisodes)
            .where(and(eq(tvEpisodes.showId, show.id), eq(tvEpisodes.seasonNumber, e.season), eq(tvEpisodes.episodeNumber, e.episode))).limit(1);
        if (!ep) { skipped++; continue; }
        const [existing] = await db.select({ id: watchHistory.id, watchedAt: watchHistory.watchedAt }).from(watchHistory)
            .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.episodeId, ep.id))).limit(1);
        if (existing) {
            if (!shouldApply(e.updatedAt, existing.watchedAt)) { skipped++; continue; }
            await db.update(watchHistory).set(values).where(eq(watchHistory.id, existing.id));
        } else {
            await db.insert(watchHistory).values({ profileId, kind: "episode", episodeId: ep.id, ...values });
        }
        applied++;
    }
    return { applied, skipped };
}

async function applyPlays(userId: string, deviceId: string, plays: ReturnType<typeof dedupePlays>, profiles: { ids: number[]; fallback: number | null }) {
    let applied = 0;
    let skipped = 0;
    for (const p of plays) {
        const key = parseTrackKey(p.trackKey);
        if (!key) { skipped++; continue; }
        const where = "sha256" in key
            ? and(eq(tracks.userId, userId), eq(tracks.sha256, key.sha256))
            : and(eq(tracks.userId, userId), or(eq(tracks.companionTrackId, key.companionTrackId), eq(tracks.id, key.companionTrackId)));
        const rows = await db.select({ id: tracks.id, companionTrackId: tracks.companionTrackId }).from(tracks).where(where).limit(2);
        const trackId = "sha256" in key
            ? rows[0]?.id
            : rows.find((r) => r.companionTrackId === key.companionTrackId)?.id ?? rows[0]?.id;
        if (!trackId) { skipped++; continue; }
        const playedAt = new Date(p.playedAt);
        const [dup] = await db.select({ id: trackPlays.id }).from(trackPlays)
            .where(and(eq(trackPlays.userId, userId), eq(trackPlays.trackId, trackId), eq(trackPlays.playedAt, playedAt))).limit(1);
        if (dup) { skipped++; continue; }
        await db.insert(trackPlays).values({
            userId,
            profileId: resolveProfileId(p.profileId, profiles.ids, profiles.fallback),
            trackId,
            deviceId,
            playedAt,
            durationSec: Math.round(p.durationSec),
            completed: p.completed,
            source: "companion",
        });
        applied++;
    }
    return { applied, skipped };
}

export async function POST(request: NextRequest) {
    const blocked = requireRate(request, { bucket: "media-sync", windowMs: 60_000, max: 120 });
    if (blocked) return blocked;
    const device = await authDevice(request);
    if (!device) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

    let raw: unknown;
    try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = syncBodySchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
    const body = parsed.data;

    const profiles = await ownedProfiles(device.userId);
    const prog = await applyProgress(device.userId, body.progress, profiles);
    const plays = await applyPlays(device.userId, device.id, dedupePlays(body.plays), profiles);

    const now = new Date();
    const [state] = await db.select({ deviceId: mediaSyncState.deviceId }).from(mediaSyncState).where(eq(mediaSyncState.deviceId, device.id)).limit(1);
    if (state) await db.update(mediaSyncState).set({ revision: body.revision, syncedAt: now }).where(eq(mediaSyncState.deviceId, device.id));
    else await db.insert(mediaSyncState).values({ deviceId: device.id, revision: body.revision, syncedAt: now });

    if (prog.applied > 0) revalidateTag(`media-home:${device.userId}`, "max");

    return NextResponse.json({
        ok: true,
        applied: { progress: prog.applied, plays: plays.applied, skipped: prog.skipped + plays.skipped },
        revision: body.revision,
    });
}

function parseSince(v: string | null): Date {
    if (!v) return new Date(0);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return new Date(n);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

export async function GET(request: NextRequest) {
    const blocked = requireRate(request, { bucket: "media-sync", windowMs: 60_000, max: 120 });
    if (blocked) return blocked;
    const device = await authDevice(request);
    if (!device) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

    const since = parseSince(request.nextUrl.searchParams.get("since"));
    const profileIds = (await db.select({ id: watchProfiles.id }).from(watchProfiles).where(eq(watchProfiles.userId, device.userId))).map((r) => r.id);
    if (profileIds.length === 0) return NextResponse.json({ since: since.toISOString(), entries: [] });

    const movieRows = await db.select({
        profileId: watchHistory.profileId, tmdbId: movies.tmdbId, positionSec: watchHistory.positionSec,
        durationSec: watchHistory.durationSec, completed: watchHistory.completed, watchedAt: watchHistory.watchedAt,
    }).from(watchHistory)
        .innerJoin(movies, eq(movies.id, watchHistory.movieId))
        .where(and(inArray(watchHistory.profileId, profileIds), gt(watchHistory.watchedAt, since)))
        .orderBy(asc(watchHistory.watchedAt)).limit(1000);
    const episodeRows = await db.select({
        profileId: watchHistory.profileId, tmdbId: tvShows.tmdbId, season: tvEpisodes.seasonNumber, episode: tvEpisodes.episodeNumber,
        positionSec: watchHistory.positionSec, durationSec: watchHistory.durationSec, completed: watchHistory.completed, watchedAt: watchHistory.watchedAt,
    }).from(watchHistory)
        .innerJoin(tvEpisodes, eq(tvEpisodes.id, watchHistory.episodeId))
        .innerJoin(tvShows, eq(tvShows.id, tvEpisodes.showId))
        .where(and(inArray(watchHistory.profileId, profileIds), gt(watchHistory.watchedAt, since)))
        .orderBy(asc(watchHistory.watchedAt)).limit(1000);

    const entries = toServerProgress([
        ...movieRows.map((r) => ({ kind: "movie" as const, season: null, episode: null, ...r })),
        ...episodeRows.map((r) => ({ kind: "episode" as const, ...r })),
    ]).sort((a, b) => a.updatedAt - b.updatedAt);
    return NextResponse.json({ since: since.toISOString(), entries });
}
