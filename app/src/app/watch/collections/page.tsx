import { auth } from "@/auth";
import { db } from "@/db";
import { videoCollections, videoCollectionItems, movies, tvShows, watchProfiles } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { getActiveProfileId } from "@/lib/active-profile";
import { PosterCard, PosterRow } from "@/components/video/poster-card";

export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
    const session = await auth();
    if (!session?.user?.id) {
        return <div style={{ padding: "4rem 2rem" }}><p>Autentifică-te ca să-ți vezi colecțiile.</p></div>;
    }
    const profileId = await getActiveProfileId();
    if (!profileId) {
        return <div style={{ padding: "4rem 2rem" }}><p>Selectează un profil ca să vezi colecțiile.</p></div>;
    }

    const rows = await db
        .select({
            c: videoCollections,
            count: sql<number>`count(${videoCollectionItems.id})::int`,
        })
        .from(videoCollections)
        .leftJoin(videoCollectionItems, eq(videoCollectionItems.collectionId, videoCollections.id))
        .innerJoin(watchProfiles, eq(watchProfiles.id, videoCollections.profileId))
        .where(and(eq(watchProfiles.userId, session.user.id), eq(videoCollections.profileId, profileId)))
        .groupBy(videoCollections.id)
        .orderBy(videoCollections.sortOrder);

    return (
        <main style={{ padding: "2rem 1.5rem 6rem" }}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
                <div>
                    <h1 style={{ fontSize: "2rem", fontWeight: 800, letterSpacing: "-0.02em" }}>Colecții</h1>
                    <p style={{ color: "var(--watch-fg-dim)", marginTop: ".25rem" }}>
                        Listele tale: wishlist, watch-later și colecții personalizate.
                    </p>
                </div>
            </header>

            {rows.length === 0 && (
                <p style={{ color: "var(--watch-fg-dim)" }}>
                    Nu ai încă nicio colecție. Apasă inima pe un film ca să-l adaugi în wishlist,
                    sau folosește butonul „Adaugă în colecție" pe o pagină de detaliu.
                </p>
            )}

            <div style={{ display: "grid", gap: "2rem" }}>
                {rows.map(async ({ c, count }) => {
                    const items = await db.select({
                        i: videoCollectionItems, m: movies, s: tvShows,
                    }).from(videoCollectionItems)
                        .leftJoin(movies, eq(movies.id, videoCollectionItems.movieId))
                        .leftJoin(tvShows, eq(tvShows.id, videoCollectionItems.showId))
                        .where(eq(videoCollectionItems.collectionId, c.id))
                        .orderBy(videoCollectionItems.sortOrder)
                        .limit(20);

                    return (
                        <section key={c.id}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 .25rem .75rem" }}>
                                <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>
                                    {c.name}
                                    <span style={{ color: "var(--watch-fg-dim)", fontWeight: 400, marginLeft: ".5rem" }}>
                                        · {count}
                                    </span>
                                </h2>
                                <Link href={`/watch/collections/${c.id}`} style={{ color: "var(--watch-fg-dim)", fontSize: ".875rem" }}>
                                    Vezi tot →
                                </Link>
                            </div>
                            {items.length === 0 ? (
                                <p style={{ color: "var(--watch-fg-dim)", padding: "0 .25rem" }}>(gol)</p>
                            ) : (
                                <PosterRow title="">
                                    {items.map(({ i, m, s }) => {
                                        if (m) {
                                            return (
                                                <PosterCard key={i.id} href={`/watch/movies/${m.id}`}
                                                    title={m.title} year={m.year ?? undefined}
                                                    posterPath={m.posterPath} />
                                            );
                                        }
                                        if (s) {
                                            return (
                                                <PosterCard key={i.id} href={`/watch/shows/${s.id}`}
                                                    title={s.title} year={s.firstAirYear ?? undefined}
                                                    posterPath={s.posterPath} />
                                            );
                                        }
                                        return null;
                                    })}
                                </PosterRow>
                            )}
                        </section>
                    );
                })}
            </div>
        </main>
    );
}
