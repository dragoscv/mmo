import { auth } from "@/auth";
import { db } from "@/db";
import { tvShows, tvEpisodes, videoFiles } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ShowDetail({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const showId = Number(id);
    if (!Number.isFinite(showId)) return notFound();

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return notFound();

    const show = await db.select().from(tvShows)
        .where(and(eq(tvShows.userId, userId), eq(tvShows.id, showId)))
        .limit(1).then(r => r[0]);
    if (!show) return notFound();

    const episodes = await db.select().from(tvEpisodes)
        .where(eq(tvEpisodes.showId, showId))
        .orderBy(asc(tvEpisodes.seasonNumber), asc(tvEpisodes.episodeNumber));

    // Map episode -> file (if any)
    const allEpisodeIds = episodes.map((e) => e.id);
    const fileRows = allEpisodeIds.length > 0
        ? await db.select().from(videoFiles).where(eq(videoFiles.userId, userId))
        : [];
    const epFile = new Map<number, number>();
    for (const f of fileRows) if (f.episodeId) epFile.set(f.episodeId, f.id);

    // Group by season
    const bySeason = new Map<number, typeof episodes>();
    for (const e of episodes) {
        const arr = bySeason.get(e.seasonNumber) ?? [];
        arr.push(e);
        bySeason.set(e.seasonNumber, arr);
    }

    const backdrop = show.backdropPath ? `https://image.tmdb.org/t/p/original${show.backdropPath}` : null;

    return (
        <main>
            <section className="watch-hero" style={{ borderRadius: 0, maxHeight: "70vh" }}>
                {backdrop && <div className="watch-hero-bg" style={{ backgroundImage: `url(${backdrop})` }} />}
                <div className="watch-hero-grain" />
                <div className="watch-hero-fade" />
                <div className="watch-hero-content" style={{ display: "flex", gap: "2rem", alignItems: "flex-end" }}>
                    {show.posterPath && (
                        <Image src={`https://image.tmdb.org/t/p/w342${show.posterPath}`} alt={show.title}
                            width={180} height={270} style={{ borderRadius: 12 }} />
                    )}
                    <div>
                        <h1 className="watch-hero-title" style={{ viewTransitionName: `show-${show.id}` }}>{show.title}</h1>
                        <p className="watch-hero-tagline">{show.firstAirYear} · {show.status ?? ""}</p>
                        <p style={{ maxWidth: "60ch", lineHeight: 1.6, marginTop: ".75rem" }}>{show.overview}</p>
                    </div>
                </div>
            </section>

            {[...bySeason.entries()].sort(([a], [b]) => a - b).map(([season, eps]) => (
                <section key={season} style={{ padding: "1.5rem" }}>
                    <h2 className="watch-row-title">Sezonul {season}</h2>
                    <ul style={{ display: "grid", gap: ".5rem", listStyle: "none", padding: 0 }}>
                        {eps.map((e) => {
                            const fileId = epFile.get(e.id);
                            return (
                                <li key={e.id} style={{ display: "flex", gap: "1rem", padding: ".75rem", borderRadius: 8, background: "var(--watch-bg-2)" }}>
                                    <div style={{ minWidth: 80, fontVariantNumeric: "tabular-nums", color: "var(--watch-fg-dim)" }}>
                                        E{String(e.episodeNumber).padStart(2, "0")}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <strong>{e.title ?? `Episod ${e.episodeNumber}`}</strong>
                                        {e.overview && <p style={{ color: "var(--watch-fg-dim)", fontSize: ".85rem", marginTop: ".25rem" }}>{e.overview}</p>}
                                    </div>
                                    {fileId ? (
                                        <Link className="watch-cta watch-cta--accent" href={`/watch/play/${fileId}`}>▶</Link>
                                    ) : (
                                        <span className="watch-pill">indisponibil</span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </main>
    );
}
