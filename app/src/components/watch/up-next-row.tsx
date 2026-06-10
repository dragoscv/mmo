import Link from "next/link";
import Image from "next/image";
import { getUpNextEpisodes, getSimilarUnwatchedMovies } from "@/actions/up-next";

const POSTER_BASE = "https://image.tmdb.org/t/p/w342";

export async function UpNextRow() {
    const [eps, recs] = await Promise.all([
        getUpNextEpisodes(8),
        getSimilarUnwatchedMovies(8),
    ]);
    if (eps.length === 0 && recs.length === 0) return null;

    return (
        <section style={{ marginTop: 32 }}>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Up Next</h2>
            <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8 }}>
                {eps.map((ep) => (
                    <Link
                        key={`ep-${ep.episodeId}`}
                        href={`/watch/shows/${ep.showId}`}
                        style={{
                            flex: "0 0 200px",
                            display: "block",
                            background: "rgba(255,255,255,0.04)",
                            borderRadius: 10,
                            overflow: "hidden",
                            color: "inherit",
                            textDecoration: "none",
                        }}
                    >
                        {ep.posterPath ? (
                            <Image
                                src={`${POSTER_BASE}${ep.posterPath}`}
                                alt={ep.showTitle}
                                width={200}
                                height={300}
                                style={{ width: "100%", height: 300, objectFit: "cover" }}
                            />
                        ) : (
                            <div style={{ width: "100%", height: 300, background: "rgba(255,255,255,0.06)" }} />
                        )}
                        <div style={{ padding: "8px 10px" }}>
                            <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ep.showTitle}</div>
                            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                                S{String(ep.season).padStart(2, "0")}E{String(ep.episode).padStart(2, "0")}
                                {ep.episodeTitle ? ` · ${ep.episodeTitle}` : ""}
                            </div>
                        </div>
                    </Link>
                ))}
                {recs.map((m) => (
                    <Link
                        key={`m-${m.movieId}`}
                        href={`/watch/movies/${m.movieId}`}
                        style={{
                            flex: "0 0 200px",
                            display: "block",
                            background: "rgba(255,255,255,0.04)",
                            borderRadius: 10,
                            overflow: "hidden",
                            color: "inherit",
                            textDecoration: "none",
                        }}
                    >
                        {m.posterPath ? (
                            <Image
                                src={`${POSTER_BASE}${m.posterPath}`}
                                alt={m.title}
                                width={200}
                                height={300}
                                style={{ width: "100%", height: 300, objectFit: "cover" }}
                            />
                        ) : (
                            <div style={{ width: "100%", height: 300, background: "rgba(255,255,255,0.06)" }} />
                        )}
                        <div style={{ padding: "8px 10px" }}>
                            <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</div>
                            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                                {m.year ?? "—"}{m.rating ? ` · ★ ${m.rating.toFixed(1)}` : ""}
                            </div>
                        </div>
                    </Link>
                ))}
            </div>
        </section>
    );
}
