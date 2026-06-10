import { auth } from "@/auth";
import { db } from "@/db";
import { movies, watchHistory, videoFiles, videoCollections, videoCollectionItems, videoRatings } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { PosterCard } from "@/components/video/poster-card";
import { getActiveProfileId } from "@/lib/active-profile";
import { listCustomCollections } from "@/actions/video-context";
import { buildMoviePosterProps } from "@/lib/poster-card-builder";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Continuă vizionarea" };
export const dynamic = "force-dynamic";

export default async function ContinueWatchingPage() {
    const session = await auth();
    if (!session?.user?.id) return <div style={{ padding: "4rem" }}>Autentifică-te.</div>;

    const profileId = await getActiveProfileId().catch(() => null);
    if (!profileId) {
        return (
            <div className="watch-empty">
                <p>Nu există un profil de vizionare activ. Creează unul mai întâi.</p>
            </div>
        );
    }

    const rows = await db.select({ h: watchHistory, m: movies })
        .from(watchHistory)
        .leftJoin(movies, eq(movies.id, watchHistory.movieId))
        .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.completed, false)))
        .orderBy(desc(watchHistory.watchedAt))
        .limit(60);

    const movieIds = rows.map((r) => r.m?.id).filter((x): x is number => x != null);
    const userId = session.user.id;
    const [files, ratings, wishlists, customCollections] = await Promise.all([
        movieIds.length
            ? db.select({
                movieId: videoFiles.movieId,
                width: videoFiles.width, height: videoFiles.height,
                hdr: videoFiles.hdr, videoCodec: videoFiles.videoCodec,
                audioCodec: videoFiles.audioCodec, bitrateKbps: videoFiles.bitrateKbps,
                audioTracks: videoFiles.audioTracks, subtitleTracks: videoFiles.subtitleTracks,
            }).from(videoFiles)
                .where(and(eq(videoFiles.userId, userId), inArray(videoFiles.movieId, movieIds)))
            : Promise.resolve([] as Array<{ movieId: number | null; width: number | null; height: number | null; hdr: string | null; videoCodec: string | null; audioCodec: string | null; bitrateKbps: number | null; audioTracks: unknown; subtitleTracks: unknown }>),
        movieIds.length
            ? db.select({ movieId: videoRatings.movieId, rating: videoRatings.rating }).from(videoRatings)
                .where(and(eq(videoRatings.profileId, profileId), inArray(videoRatings.movieId, movieIds)))
            : Promise.resolve([] as Array<{ movieId: number | null; rating: number }>),
        db.select({ movieId: videoCollectionItems.movieId }).from(videoCollectionItems)
            .innerJoin(videoCollections, eq(videoCollections.id, videoCollectionItems.collectionId))
            .where(and(eq(videoCollections.profileId, profileId), eq(videoCollections.kind, "wishlist"))),
        listCustomCollections(),
    ]);
    const filesByMovie = new Map<number, typeof files>();
    for (const f of files) {
        if (f.movieId == null) continue;
        const arr = filesByMovie.get(f.movieId) ?? [];
        arr.push(f);
        filesByMovie.set(f.movieId, arr);
    }
    const ratingMap = new Map<number, number>();
    for (const r of ratings) if (r.movieId != null) ratingMap.set(r.movieId, r.rating);
    const wishlistSet = new Set(wishlists.map((w) => w.movieId).filter((x): x is number => x != null));
    const customs = customCollections.filter((c) => c.kind === "custom").map((c) => ({ id: c.id, name: c.name }));

    const t = await getTranslations("watch.continuePage");

    return (
        <main style={{ padding: "1.5rem" }}>
            <header style={{ marginBottom: "1.5rem" }}>
                <h1 style={{ fontSize: "1.8rem", fontWeight: 800 }}>{t("title")}</h1>
                <p style={{ color: "var(--watch-fg-dim)" }}>
                    {t("lead")}
                </p>
            </header>
            {rows.length === 0 ? (
                <div className="watch-empty">
                    <p>Nu există nimic în desfășurare. Pornește un film sau un episod și va apărea aici.</p>
                </div>
            ) : (
                <div className="watch-grid">
                    {rows.map(({ h, m }) => m ? (
                        <PosterCard
                            key={h.id}
                            {...buildMoviePosterProps(m, {
                                files: filesByMovie.get(m.id) ?? [],
                                liked: (ratingMap.get(m.id) ?? 0) >= 8,
                                inWishlist: wishlistSet.has(m.id),
                                customCollections: customs,
                                progress: h.durationSec && h.durationSec > 0 ? h.positionSec / h.durationSec : undefined,
                                resumeSec: h.positionSec ?? undefined,
                            })}
                        />
                    ) : null)}
                </div>
            )}
        </main>
    );
}
