import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, videoFiles, watchHistory, watchProfiles } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { tmdbTrending } from "@/lib/tmdb";
import { PosterCard, PosterRow } from "@/components/video/poster-card";
import { ImportLibraryButton } from "./_import-button";
import { getActiveProfileId } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function WatchHome() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return (
            <div style={{ padding: "4rem 2rem" }}>
                <h1>Watch</h1>
                <p>Autentifică-te pentru a-ți vedea biblioteca.</p>
            </div>
        );
    }

    const activeProfileId = await getActiveProfileId();
    const [recentMovies, recentShows, recentFiles, profile, trending] = await Promise.all([
        db.select().from(movies).where(eq(movies.userId, userId)).orderBy(desc(movies.addedAt)).limit(20),
        db.select().from(tvShows).where(eq(tvShows.userId, userId)).orderBy(desc(tvShows.addedAt)).limit(20),
        db.select().from(videoFiles).where(eq(videoFiles.userId, userId)).orderBy(desc(videoFiles.scannedAt)).limit(20),
        activeProfileId ? db.select().from(watchProfiles).where(eq(watchProfiles.id, activeProfileId)).limit(1).then(r => r[0] ?? null) : Promise.resolve(null),
        tmdbTrending("movie", "week"),
    ]);

    const continueRows = profile ? await db.select({
        h: watchHistory,
        m: movies,
    }).from(watchHistory)
        .leftJoin(movies, eq(movies.id, watchHistory.movieId))
        .where(and(eq(watchHistory.profileId, profile.id), eq(watchHistory.completed, false)))
        .orderBy(desc(watchHistory.watchedAt))
        .limit(15) : [];

    const hasLocal = recentFiles.length > 0;

    return (
        <main>
            <header style={{ padding: "2rem 1.5rem 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: "2rem", fontWeight: 800, letterSpacing: "-0.02em" }}>Watch</h1>
                    <p style={{ color: "var(--watch-fg-dim)", marginTop: ".25rem" }}>
                        Filme, seriale și clipurile tale locale.{" "}
                        {hasLocal ? `${recentFiles.length}+ fișiere indexate.` : "Niciun fișier indexat încă."}
                    </p>
                </div>
                <ImportLibraryButton />
            </header>

            {continueRows.length > 0 && (
                <PosterRow title="Continuă vizionarea">
                    {continueRows.map(({ h, m }) => m ? (
                        <PosterCard key={h.id} href={`/watch/movies/${m.id}`}
                            title={m.title} year={m.year} posterPath={m.posterPath}
                            progress={h.durationSec && h.durationSec > 0 ? h.positionSec / h.durationSec : undefined} />
                    ) : null)}
                </PosterRow>
            )}

            {recentMovies.length > 0 && (
                <PosterRow title="Filme adăugate recent">
                    {recentMovies.map((m) => (
                        <PosterCard key={m.id} href={`/watch/movies/${m.id}`}
                            title={m.title} year={m.year} posterPath={m.posterPath}
                            transitionName={`movie-${m.id}`} />
                    ))}
                </PosterRow>
            )}

            {recentShows.length > 0 && (
                <PosterRow title="Seriale adăugate recent">
                    {recentShows.map((s) => (
                        <PosterCard key={s.id} href={`/watch/shows/${s.id}`}
                            title={s.title} year={s.firstAirYear} posterPath={s.posterPath}
                            transitionName={`show-${s.id}`} />
                    ))}
                </PosterRow>
            )}

            {trending.length > 0 && (
                <PosterRow title="În trend pe TMDB (săptămâna asta)">
                    {trending.slice(0, 20).map((t) => (
                        <PosterCard key={t.id} href={`/watch/discover/movie/${t.id}`}
                            title={t.title ?? t.name ?? ""}
                            year={t.release_date ? parseInt(t.release_date.slice(0, 4), 10) : null}
                            posterPath={t.poster_path} />
                    ))}
                </PosterRow>
            )}

            {!hasLocal && trending.length === 0 && (
                <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--watch-fg-dim)" }}>
                    <p>Configurează un companion și rulează un scan pentru a-ți vedea filmele locale.</p>
                    <p style={{ marginTop: "1rem" }}>
                        <Link href="/settings" style={{ color: "var(--watch-accent)" }}>Setări &rarr;</Link>
                    </p>
                </div>
            )}
        </main>
    );
}
