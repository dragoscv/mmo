import { auth } from "@/auth";
import { db } from "@/db";
import { movies, watchHistory, videoCollections, videoCollectionItems, videoRatings, videoFiles } from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, sql, inArray } from "drizzle-orm";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PosterCard } from "@/components/video/poster-card";
import { WatchFilterBar } from "@/components/video/watch-filter-bar";
import { getActiveProfileId, ensureDefaultWatchProfile } from "@/lib/active-profile";
import { listCustomCollections } from "@/actions/video-context";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { buildMoviePosterProps } from "@/lib/poster-card-builder";

export const dynamic = "force-dynamic";

interface Search {
    q?: string;
    genre?: string;
    year?: string;
    minRating?: string;
    sort?: string;
}

export default async function MoviesPage({ searchParams }: { searchParams: Promise<Search> }) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return <main style={{ padding: "2rem" }}><p>Autentifică-te.</p></main>;
    const sp = await searchParams;

    const profileId = (await getActiveProfileId()) ?? (await ensureDefaultWatchProfile());
    const prefs = await getWatchPrefs();
    const hidden = new Set(prefs.hiddenMovieTmdbIds ?? []);

    const filters = [eq(movies.userId, userId)];
    if (sp.q) filters.push(ilike(movies.title, `%${sp.q}%`));
    if (sp.year) {
        const y = parseInt(sp.year, 10);
        if (Number.isFinite(y)) filters.push(eq(movies.year, y));
    }
    if (sp.minRating) {
        const r = parseFloat(sp.minRating);
        if (Number.isFinite(r)) filters.push(gte(movies.rating, r));
    }
    if (sp.genre) {
        filters.push(sql`${movies.genres} @> ${JSON.stringify([{ name: sp.genre }])}::jsonb`);
    }

    const orderBy = (() => {
        switch (sp.sort) {
            case "added_asc": return asc(movies.addedAt);
            case "title_asc": return asc(movies.title);
            case "title_desc": return desc(movies.title);
            case "year_desc": return desc(movies.year);
            case "year_asc": return asc(movies.year);
            case "rating_desc": return desc(movies.rating);
            default: return desc(movies.addedAt);
        }
    })();

    const rows = await db.select().from(movies).where(and(...filters)).orderBy(orderBy);
    const visible = rows.filter((m) => !m.tmdbId || !hidden.has(m.tmdbId));

    const ids = visible.map((m) => m.id);
    const [watched, ratings, wishlists, collections, files] = await Promise.all([
        profileId && ids.length
            ? db.select({ movieId: watchHistory.movieId }).from(watchHistory)
                .where(and(eq(watchHistory.profileId, profileId), inArray(watchHistory.movieId, ids)))
            : Promise.resolve([] as Array<{ movieId: number | null }>),
        profileId && ids.length
            ? db.select({ movieId: videoRatings.movieId, rating: videoRatings.rating }).from(videoRatings)
                .where(and(eq(videoRatings.profileId, profileId), inArray(videoRatings.movieId, ids)))
            : Promise.resolve([] as Array<{ movieId: number | null; rating: number }>),
        profileId
            ? db.select({ movieId: videoCollectionItems.movieId }).from(videoCollectionItems)
                .innerJoin(videoCollections, eq(videoCollections.id, videoCollectionItems.collectionId))
                .where(and(eq(videoCollections.profileId, profileId), eq(videoCollections.kind, "wishlist")))
            : Promise.resolve([] as Array<{ movieId: number | null }>),
        listCustomCollections(),
        ids.length
            ? db.select({
                movieId: videoFiles.movieId,
                width: videoFiles.width, height: videoFiles.height,
                hdr: videoFiles.hdr, videoCodec: videoFiles.videoCodec,
                audioCodec: videoFiles.audioCodec, bitrateKbps: videoFiles.bitrateKbps,
                audioTracks: videoFiles.audioTracks, subtitleTracks: videoFiles.subtitleTracks,
            }).from(videoFiles)
                .where(and(eq(videoFiles.userId, userId), inArray(videoFiles.movieId, ids)))
            : Promise.resolve([] as Array<{ movieId: number | null; width: number | null; height: number | null; hdr: string | null; videoCodec: string | null; audioCodec: string | null; bitrateKbps: number | null; audioTracks: unknown; subtitleTracks: unknown }>),
    ]);

    const watchedSet = new Set(watched.map((w) => w.movieId).filter((x): x is number => x != null));
    const wishlistSet = new Set(wishlists.map((w) => w.movieId).filter((x): x is number => x != null));
    const ratingMap = new Map<number, number>();
    for (const r of ratings) if (r.movieId != null) ratingMap.set(r.movieId, r.rating);
    const filesByMovie = new Map<number, typeof files>();
    for (const f of files) {
        if (f.movieId == null) continue;
        const arr = filesByMovie.get(f.movieId) ?? [];
        arr.push(f);
        filesByMovie.set(f.movieId, arr);
    }

    const facetYears = Array.from(new Set(rows.map((m) => m.year).filter((y): y is number => y != null))).sort((a, b) => b - a);
    const facetGenres = Array.from(new Set(rows.flatMap((m) => {
        const g = m.genres as unknown;
        return Array.isArray(g) ? g.map((x: { name?: string }) => x.name).filter((n): n is string => !!n) : [];
    }))).sort();

    const customCollections = collections
        .filter((c) => c.kind === "custom")
        .map((c) => ({ id: c.id, name: c.name }));

    const t = await getTranslations("watch.moviesPage");

    return (
        <main>
            <header style={{ padding: "2rem 1.5rem 0" }}>
                <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>{t("title")}</h1>
            </header>
            <WatchFilterBar genres={facetGenres} years={facetYears} count={visible.length} />
            {visible.length === 0 ? (
                <div style={{ padding: "4rem 2rem", color: "var(--watch-fg-dim)" }}>
                    {rows.length > 0 ? (
                        <p>{t("noResults")}</p>
                    ) : (
                        <p>{t("empty")} <Link href="/watch" style={{ color: "var(--watch-accent)" }}>{t("runScan")}</Link></p>
                    )}
                </div>
            ) : (
                <div className="watch-grid">
                    {visible.map((m) => (
                        <PosterCard
                            key={m.id}
                            {...buildMoviePosterProps(m, {
                                files: filesByMovie.get(m.id) ?? [],
                                watched: watchedSet.has(m.id),
                                liked: (ratingMap.get(m.id) ?? 0) >= 8,
                                inWishlist: wishlistSet.has(m.id),
                                customCollections,
                            })}
                        />
                    ))}
                </div>
            )}
        </main>
    );
}
