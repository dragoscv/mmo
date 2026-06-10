import { auth } from "@/auth";
import { db } from "@/db";
import { watchHistory, movies, tvShows, tvEpisodes } from "@/db/schema";
import { getActiveProfileId } from "@/lib/active-profile";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import { WatchDailyChart } from "@/components/watch/stats-chart";

export const dynamic = "force-dynamic";

export default async function WatchStatsPage() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    const profileId = await getActiveProfileId().catch(() => null);
    if (!profileId) {
        return (
            <main style={{ padding: "2rem" }}>
                <h1 className="watch-row-title">Statistici</h1>
                <p style={{ color: "var(--watch-fg-dim)" }}>Niciun profil activ.</p>
                <Link className="watch-cta" href="/watch">Înapoi</Link>
            </main>
        );
    }

    const since = new Date();
    since.setDate(since.getDate() - 30);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);

    // Pull recent history with linked metadata
    const [moviesDone, episodesDone, totals, weekTotals, monthTotals, sessionAvg, dailyDays, daily, topShows, topMovies] = await Promise.all([
        db.select({ c: sql<number>`count(*)::int` })
            .from(watchHistory)
            .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.kind, "movie"), eq(watchHistory.completed, true))),
        db.select({ c: sql<number>`count(*)::int` })
            .from(watchHistory)
            .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.kind, "episode"), eq(watchHistory.completed, true))),
        db.select({ minutes: sql<number>`coalesce(sum(position_sec)/60, 0)::int` })
            .from(watchHistory)
            .where(eq(watchHistory.profileId, profileId)),
        db.select({ minutes: sql<number>`coalesce(sum(position_sec)/60, 0)::int` })
            .from(watchHistory)
            .where(and(eq(watchHistory.profileId, profileId), gte(watchHistory.watchedAt, weekAgo))),
        db.select({ minutes: sql<number>`coalesce(sum(position_sec)/60, 0)::int` })
            .from(watchHistory)
            .where(and(eq(watchHistory.profileId, profileId), gte(watchHistory.watchedAt, monthAgo))),
        db.select({ avg: sql<number>`coalesce(avg(position_sec)/60, 0)::int` })
            .from(watchHistory)
            .where(and(eq(watchHistory.profileId, profileId), gte(watchHistory.positionSec, 60))),
        db.select({ day: sql<string>`to_char(date_trunc('day', watched_at), 'YYYY-MM-DD')` })
            .from(watchHistory)
            .where(eq(watchHistory.profileId, profileId))
            .groupBy(sql`date_trunc('day', watched_at)`)
            .orderBy(desc(sql`date_trunc('day', watched_at)`))
            .limit(365),
        db.select({
            day: sql<string>`to_char(date_trunc('day', watched_at), 'MM-DD')`,
            minutes: sql<number>`coalesce(sum(position_sec)/60, 0)::int`,
        })
            .from(watchHistory)
            .where(and(eq(watchHistory.profileId, profileId), gte(watchHistory.watchedAt, since)))
            .groupBy(sql`date_trunc('day', watched_at)`)
            .orderBy(sql`date_trunc('day', watched_at)`),
        db.select({
            id: tvShows.id, title: tvShows.title, poster: tvShows.posterPath,
            minutes: sql<number>`coalesce(sum(${watchHistory.positionSec})/60, 0)::int`,
        })
            .from(watchHistory)
            .innerJoin(tvEpisodes, eq(tvEpisodes.id, watchHistory.episodeId))
            .innerJoin(tvShows, eq(tvShows.id, tvEpisodes.showId))
            .where(eq(watchHistory.profileId, profileId))
            .groupBy(tvShows.id, tvShows.title, tvShows.posterPath)
            .orderBy(desc(sql`sum(${watchHistory.positionSec})`))
            .limit(5),
        db.select({
            id: movies.id, title: movies.title, poster: movies.posterPath,
            minutes: sql<number>`coalesce(sum(${watchHistory.positionSec})/60, 0)::int`,
        })
            .from(watchHistory)
            .innerJoin(movies, eq(movies.id, watchHistory.movieId))
            .where(eq(watchHistory.profileId, profileId))
            .groupBy(movies.id, movies.title, movies.posterPath)
            .orderBy(desc(sql`sum(${watchHistory.positionSec})`))
            .limit(5),
    ]);

    // Top genres across movies + shows (best-effort, in-memory aggregation)
    const genreCounts = new Map<string, number>();
    const allWatched = await db.select({
        movieGenres: movies.genres,
        showGenres: tvShows.genres,
        minutes: sql<number>`(${watchHistory.positionSec}/60)::int`,
    })
        .from(watchHistory)
        .leftJoin(movies, eq(movies.id, watchHistory.movieId))
        .leftJoin(tvEpisodes, eq(tvEpisodes.id, watchHistory.episodeId))
        .leftJoin(tvShows, eq(tvShows.id, tvEpisodes.showId))
        .where(eq(watchHistory.profileId, profileId));
    for (const row of allWatched) {
        const raw = (row.movieGenres ?? row.showGenres) as Array<{ name?: string }> | null;
        if (!raw) continue;
        for (const g of raw) {
            if (!g?.name) continue;
            genreCounts.set(g.name, (genreCounts.get(g.name) ?? 0) + (row.minutes ?? 0));
        }
    }
    const topGenres = [...genreCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, minutes]) => ({ name, minutes }));

    const totalMin = totals[0]?.minutes ?? 0;
    const totalHours = (totalMin / 60).toFixed(1);

    // Streak: count consecutive days from today backwards in dailyDays
    const daySet = new Set(dailyDays.map((d) => d.day));
    let streak = 0;
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    while (true) {
        const key = cursor.toISOString().slice(0, 10);
        if (!daySet.has(key)) {
            // Allow today gap (current day may not have logged yet) but only once at the top.
            if (streak === 0) {
                cursor.setDate(cursor.getDate() - 1);
                continue;
            }
            break;
        }
        streak++;
        cursor.setDate(cursor.getDate() - 1);
        if (streak > 365) break;
    }

    const weekMin = weekTotals[0]?.minutes ?? 0;
    const monthMin = monthTotals[0]?.minutes ?? 0;
    const avgSession = sessionAvg[0]?.avg ?? 0;

    return (
        <main style={{ padding: "2rem", maxWidth: 1200, margin: "0 auto" }}>
            <h1 className="watch-row-title">Statistici vizionare</h1>

            <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginTop: "1.5rem" }}>
                <StatCard label="Timp total" value={`${totalHours} h`} hint={`${totalMin} minute`} />
                <StatCard label="Săptămâna asta" value={`${weekMin} min`} />
                <StatCard label="Luna asta" value={`${(monthMin / 60).toFixed(1)} h`} hint={`${monthMin} min`} />
                <StatCard label="Streak" value={`${streak} ${streak === 1 ? "zi" : "zile"}`} hint="Zile consecutive" />
                <StatCard label="Sesiune medie" value={`${avgSession} min`} />
                <StatCard label="Filme finalizate" value={String(moviesDone[0]?.c ?? 0)} />
                <StatCard label="Episoade finalizate" value={String(episodesDone[0]?.c ?? 0)} />
            </section>

            <section style={{ marginTop: "2rem" }}>
                <h2 className="watch-row-title">Ultimele 30 de zile</h2>
                {daily.length > 0 ? (
                    <div style={{ background: "var(--watch-bg-2)", padding: "1rem", borderRadius: 12 }}>
                        <WatchDailyChart data={daily} />
                    </div>
                ) : (
                    <p style={{ color: "var(--watch-fg-dim)" }}>Nimic vizionat în această perioadă.</p>
                )}
            </section>

            {topShows.length > 0 && (
                <section style={{ marginTop: "2rem" }}>
                    <h2 className="watch-row-title">Top seriale</h2>
                    <ul style={{ display: "grid", gap: ".5rem", listStyle: "none", padding: 0 }}>
                        {topShows.map((s) => (
                            <li key={s.id}>
                                <Link href={`/watch/shows/${s.id}`} style={{ display: "flex", gap: "1rem", alignItems: "center", padding: ".75rem", background: "var(--watch-bg-2)", borderRadius: 8, textDecoration: "none", color: "var(--watch-fg)" }}>
                                    <strong style={{ flex: 1 }}>{s.title}</strong>
                                    <span style={{ color: "var(--watch-fg-dim)", fontVariantNumeric: "tabular-nums" }}>{s.minutes} min</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {topMovies.length > 0 && (
                <section style={{ marginTop: "2rem" }}>
                    <h2 className="watch-row-title">Top filme</h2>
                    <ul style={{ display: "grid", gap: ".5rem", listStyle: "none", padding: 0 }}>
                        {topMovies.map((m) => (
                            <li key={m.id}>
                                <Link href={`/watch/movies/${m.id}`} style={{ display: "flex", gap: "1rem", alignItems: "center", padding: ".75rem", background: "var(--watch-bg-2)", borderRadius: 8, textDecoration: "none", color: "var(--watch-fg)" }}>
                                    <strong style={{ flex: 1 }}>{m.title}</strong>
                                    <span style={{ color: "var(--watch-fg-dim)", fontVariantNumeric: "tabular-nums" }}>{m.minutes} min</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {topGenres.length > 0 && (
                <section style={{ marginTop: "2rem" }}>
                    <h2 className="watch-row-title">Top genuri</h2>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: ".5rem" }}>
                        {topGenres.map((g) => (
                            <span key={g.name} className="watch-pill" title={`${g.minutes} minute`}>
                                {g.name} · {g.minutes}m
                            </span>
                        ))}
                    </div>
                </section>
            )}
        </main>
    );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div style={{ background: "var(--watch-bg-2)", borderRadius: 12, padding: "1.25rem" }}>
            <p style={{ color: "var(--watch-fg-dim)", fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</p>
            <p style={{ fontSize: "2rem", fontWeight: 700, margin: ".25rem 0", color: "var(--watch-fg)" }}>{value}</p>
            {hint && <p style={{ color: "var(--watch-fg-dim)", fontSize: ".75rem" }}>{hint}</p>}
        </div>
    );
}
