import Link from "next/link";
import Image from "next/image";
import { getWatchlist } from "@/actions/watchlist";

const POSTER_BASE = "https://image.tmdb.org/t/p/w342";

export async function WatchlistRow() {
    const items = await getWatchlist();
    if (items.length === 0) return null;
    return (
        <section style={{ marginTop: 32 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                <h2 style={{ fontSize: 22, fontWeight: 700, flex: 1 }}>În watchlist</h2>
                <Link href="/watch/watchlist" style={{ fontSize: 12, opacity: 0.7 }}>Vezi toate →</Link>
            </div>
            <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 8 }}>
                {items.slice(0, 24).map(it => (
                    <Link
                        key={`${it.kind}-${it.id}`}
                        href={it.kind === "movie" ? `/watch/movies/${it.id}` : `/watch/shows/${it.id}`}
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
                        {it.posterPath ? (
                            <Image
                                src={`${POSTER_BASE}${it.posterPath}`}
                                alt={it.title}
                                width={200}
                                height={300}
                                style={{ width: "100%", height: 300, objectFit: "cover" }}
                            />
                        ) : (
                            <div style={{ width: "100%", height: 300, background: "rgba(255,255,255,0.06)" }} />
                        )}
                        <div style={{ padding: "8px 10px" }}>
                            <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
                            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                                {it.year ?? "—"} · {it.kind === "movie" ? "Film" : "Serial"}
                            </div>
                        </div>
                    </Link>
                ))}
            </div>
        </section>
    );
}
