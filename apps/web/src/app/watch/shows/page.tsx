import { auth } from "@/auth";
import { db } from "@/db";
import { tvShows, watchHistory, tvEpisodes, videoCollections, videoCollectionItems, videoRatings } from "@/db/schema";
import { and, asc, desc, eq, gte, ilike, sql, inArray } from "drizzle-orm";
import Link from "next/link";
import { PosterCard } from "@/components/video/poster-card";
import { WatchFilterBar } from "@/components/video/watch-filter-bar";
import { getActiveProfileId, ensureDefaultWatchProfile } from "@/lib/active-profile";
import { listCustomCollections } from "@/actions/video-context";
import { getWatchPrefs } from "@/actions/watch-prefs";
import { buildShowPosterProps } from "@/lib/poster-card-builder";

export const dynamic = "force-dynamic";

interface Search {
    q?: string;
    genre?: string;
    year?: string;
    minRating?: string;
    sort?: string;
}

export default async function ShowsPage({ searchParams }: { searchParams: Promise<Search> }) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return <main style={{ padding: "2rem" }}><p>Autentifică-te.</p></main>;
    const sp = await searchParams;

    const profileId = (await getActiveProfileId()) ?? (await ensureDefaultWatchProfile());
    const prefs = await getWatchPrefs();
    const hidden = new Set(prefs.hiddenShowTmdbIds ?? []);

    const filters = [eq(tvShows.userId, userId)];
    if (sp.q) filters.push(ilike(tvShows.title, `%${sp.q}%`));
    if (sp.year) {
        const y = parseInt(sp.year, 10);
        if (Number.isFinite(y)) filters.push(eq(tvShows.firstAirYear, y));
    }
    if (sp.minRating) {
        const r = parseFloat(sp.minRating);
        if (Number.isFinite(r)) filters.push(gte(tvShows.rating, r));
    }
    if (sp.genre) {
        filters.push(sql`${tvShows.genres} @> ${JSON.stringify([{ name: sp.genre }])}::jsonb`);
    }

    const orderBy = (() => {
        switch (sp.sort) {
            case "added_asc": return asc(tvShows.addedAt);
            case "title_asc": return asc(tvShows.title);
            case "title_desc": return desc(tvShows.title);
            case "year_desc": return desc(tvShows.firstAirYear);
            case "year_asc": return asc(tvShows.firstAirYear);
            case "rating_desc": return desc(tvShows.rating);
            default: return desc(tvShows.addedAt);
        }
    })();

    const rows = await db.select().from(tvShows).where(and(...filters)).orderBy(orderBy);
    const visible = rows.filter((s) => !s.tmdbId || !hidden.has(s.tmdbId));

    const ids = visible.map((s) => s.id);
    const [watchedEpisodes, ratings, wishlists, collections] = await Promise.all([
        profileId && ids.length
            ? db.select({ showId: tvEpisodes.showId })
                .from(watchHistory)
                .innerJoin(tvEpisodes, eq(tvEpisodes.id, watchHistory.episodeId))
                .where(and(eq(watchHistory.profileId, profileId), inArray(tvEpisodes.showId, ids)))
            : Promise.resolve([] as Array<{ showId: number }>),
        profileId && ids.length
            ? db.select({ showId: videoRatings.showId, rating: videoRatings.rating }).from(videoRatings)
                .where(and(eq(videoRatings.profileId, profileId), inArray(videoRatings.showId, ids)))
            : Promise.resolve([] as Array<{ showId: number | null; rating: number }>),
        profileId
            ? db.select({ showId: videoCollectionItems.showId }).from(videoCollectionItems)
                .innerJoin(videoCollections, eq(videoCollections.id, videoCollectionItems.collectionId))
                .where(and(eq(videoCollections.profileId, profileId), eq(videoCollections.kind, "wishlist")))
            : Promise.resolve([] as Array<{ showId: number | null }>),
        listCustomCollections(),
    ]);

    const watchedSet = new Set(watchedEpisodes.map((w) => w.showId));
    const wishlistSet = new Set(wishlists.map((w) => w.showId).filter((x): x is number => x != null));
    const ratingMap = new Map<number, number>();
    for (const r of ratings) if (r.showId != null) ratingMap.set(r.showId, r.rating);

    const facetYears = Array.from(new Set(rows.map((s) => s.firstAirYear).filter((y): y is number => y != null))).sort((a, b) => b - a);
    const facetGenres = Array.from(new Set(rows.flatMap((s) => {
        const g = s.genres as unknown;
        return Array.isArray(g) ? g.map((x: { name?: string }) => x.name).filter((n): n is string => !!n) : [];
    }))).sort();

    const customCollections = collections
        .filter((c) => c.kind === "custom")
        .map((c) => ({ id: c.id, name: c.name }));

    return (
        <main>
            <header style={{ padding: "2rem 1.5rem 0" }}>
                <h1 style={{ fontSize: "2rem", fontWeight: 800 }}>Serialele tale</h1>
            </header>
            <WatchFilterBar genres={facetGenres} years={facetYears} count={visible.length} />
            {visible.length === 0 ? (
                <div style={{ padding: "4rem 2rem", color: "var(--watch-fg-dim)" }}>
                    {rows.length > 0 ? (
                        <p>Niciun serial care să corespundă filtrelor.</p>
                    ) : (
                        <p>Niciun serial încă. <Link href="/watch" style={{ color: "var(--watch-accent)" }}>Rulează un scan.</Link></p>
                    )}
                </div>
            ) : (
                <div className="watch-grid">
                    {visible.map((s) => (
                        <PosterCard
                            key={s.id}
                            {...buildShowPosterProps(s, {
                                watched: watchedSet.has(s.id),
                                liked: (ratingMap.get(s.id) ?? 0) >= 8,
                                inWishlist: wishlistSet.has(s.id),
                                customCollections,
                            })}
                        />
                    ))}
                </div>
            )}
        </main>
    );
}
