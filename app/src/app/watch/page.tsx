import { Suspense } from "react";
import Link from "next/link";
import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, videoFiles, watchHistory } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { tmdbTrending } from "@/lib/tmdb";
import { PosterCard, PosterRow } from "@/components/video/poster-card";
import { ImportLibraryButton } from "./_import-button";
import { getActiveProfileId } from "@/lib/active-profile";
import { CompanionOfflineBanner } from "@/components/companion/companion-offline-banner";

export const dynamic = "force-dynamic";

// Each section is its own async server component wrapped in Suspense so
// a single failing query renders an empty row instead of 500-ing the
// whole page. `safe()` swallows DB / TMDB faults; error.tsx still
// catches auth() / layout crashes.
async function safe<T>(fn: () => Promise<T>, fallback: T, tag: string): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        console.error(`[/watch] ${tag} failed:`, err);
        return fallback;
    }
}

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

    const hasLocalSeed = await safe(
        () => db.select({ id: videoFiles.id }).from(videoFiles).where(eq(videoFiles.userId, userId)).limit(1),
        [],
        "local-seed",
    );
    const hasLocal = hasLocalSeed.length > 0;

    return (
        <main>
            <header style={{ padding: "2rem 1.5rem 0", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: "2rem", fontWeight: 800, letterSpacing: "-0.02em" }}>Watch</h1>
                    <p style={{ color: "var(--watch-fg-dim)", marginTop: ".25rem" }}>
                        Filme, seriale și clipurile tale locale.
                    </p>
                </div>
                <ImportLibraryButton />
            </header>

            <CompanionOfflineBanner />

            <Suspense fallback={<RowSkeleton title="Continuă vizionarea" />}>
                <ContinueWatchingRow />
            </Suspense>

            <Suspense fallback={<RowSkeleton title="Filme adăugate recent" />}>
                <RecentMoviesRow userId={userId} />
            </Suspense>

            <Suspense fallback={<RowSkeleton title="Seriale adăugate recent" />}>
                <RecentShowsRow userId={userId} />
            </Suspense>

            <Suspense fallback={<RowSkeleton title="În trend pe TMDB (săptămâna asta)" />}>
                <TrendingRow />
            </Suspense>

            {!hasLocal && (
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

function RowSkeleton({ title }: { title: string }) {
    return (
        <section style={{ padding: "1.5rem 1.5rem 0" }}>
            <h2 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: ".75rem", opacity: 0.5 }}>{title}</h2>
            <div style={{ display: "flex", gap: ".75rem", overflow: "hidden" }}>
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} style={{ flex: "0 0 150px", aspectRatio: "2/3", borderRadius: 8, background: "rgba(255,255,255,0.04)" }} />
                ))}
            </div>
        </section>
    );
}

async function ContinueWatchingRow() {
    const profileId = await safe(() => getActiveProfileId(), null, "active-profile");
    if (!profileId) return null;

    const rows = await safe(
        () => db.select({ h: watchHistory, m: movies }).from(watchHistory)
            .leftJoin(movies, eq(movies.id, watchHistory.movieId))
            .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.completed, false)))
            .orderBy(desc(watchHistory.watchedAt))
            .limit(15),
        [],
        "continue-watching",
    );
    if (rows.length === 0) return null;

    return (
        <PosterRow title="Continuă vizionarea">
            {rows.map(({ h, m }) => m ? (
                <PosterCard key={h.id} href={`/watch/movies/${m.id}`}
                    title={m.title} year={m.year} posterPath={m.posterPath}
                    progress={h.durationSec && h.durationSec > 0 ? h.positionSec / h.durationSec : undefined} />
            ) : null)}
        </PosterRow>
    );
}

async function RecentMoviesRow({ userId }: { userId: string }) {
    const rows = await safe(
        () => db.select().from(movies).where(eq(movies.userId, userId)).orderBy(desc(movies.addedAt)).limit(20),
        [],
        "recent-movies",
    );
    if (rows.length === 0) return null;
    return (
        <PosterRow title="Filme adăugate recent">
            {rows.map((m) => (
                <PosterCard key={m.id} href={`/watch/movies/${m.id}`}
                    title={m.title} year={m.year} posterPath={m.posterPath}
                    transitionName={`movie-${m.id}`} />
            ))}
        </PosterRow>
    );
}

async function RecentShowsRow({ userId }: { userId: string }) {
    const rows = await safe(
        () => db.select().from(tvShows).where(eq(tvShows.userId, userId)).orderBy(desc(tvShows.addedAt)).limit(20),
        [],
        "recent-shows",
    );
    if (rows.length === 0) return null;
    return (
        <PosterRow title="Seriale adăugate recent">
            {rows.map((s) => (
                <PosterCard key={s.id} href={`/watch/shows/${s.id}`}
                    title={s.title} year={s.firstAirYear} posterPath={s.posterPath}
                    transitionName={`show-${s.id}`} />
            ))}
        </PosterRow>
    );
}

async function TrendingRow() {
    const trending = await safe(() => tmdbTrending("movie", "week"), [], "tmdb-trending");
    if (trending.length === 0) return null;
    return (
        <PosterRow title="În trend pe TMDB (săptămâna asta)">
            {trending.slice(0, 20).map((t) => (
                <PosterCard key={t.id} href={`/watch/discover/movie/${t.id}`}
                    title={t.title ?? t.name ?? ""}
                    year={t.release_date ? parseInt(t.release_date.slice(0, 4), 10) : null}
                    posterPath={t.poster_path} />
            ))}
        </PosterRow>
    );
}
