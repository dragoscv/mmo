import Image from "next/image";
import type { TmdbWatchProvider } from "@/lib/tmdb";

interface Props {
    link: string | null;
    flatrate: Array<TmdbWatchProvider & { regions: string[] }>;
    rent: Array<TmdbWatchProvider & { regions: string[] }>;
    buy: Array<TmdbWatchProvider & { regions: string[] }>;
    free: Array<TmdbWatchProvider & { regions: string[] }>;
}

/** Inline row of provider logos (subscription first, then free/rent/buy).
 *  Each logo opens the TMDB-provided regional redirect in a new tab. */
export function ExternalProvidersRow({ link, flatrate, rent, buy, free }: Props) {
    const all = [
        ...flatrate.map((p) => ({ ...p, badge: "Sub" })),
        ...free.map((p) => ({ ...p, badge: "Free" })),
        ...rent.map((p) => ({ ...p, badge: "Rent" })),
        ...buy.map((p) => ({ ...p, badge: "Buy" })),
    ];
    if (all.length === 0) return null;

    return (
        <section style={{ padding: "1.5rem" }}>
            <h2 className="watch-row-title">Where to watch</h2>
            <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
                {all.map((p, i) => (
                    <a
                        key={`${p.provider_id}-${i}-${p.badge}`}
                        href={link ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${p.provider_name} (${p.badge}) — ${p.regions.join(", ")}`}
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: ".25rem",
                            textDecoration: "none",
                            color: "var(--watch-fg)",
                            transition: "transform .15s ease",
                        }}
                        className="external-provider-tile"
                    >
                        <div style={{ width: 56, height: 56, borderRadius: 12, overflow: "hidden", background: "#fff", boxShadow: "0 4px 12px rgba(0,0,0,.4)" }}>
                            <Image
                                src={`https://image.tmdb.org/t/p/w185${p.logo_path}`}
                                alt={p.provider_name}
                                width={56}
                                height={56}
                                style={{ objectFit: "cover" }}
                            />
                        </div>
                        <span style={{ fontSize: ".68rem", color: "var(--watch-fg-dim)", letterSpacing: ".5px" }}>
                            {p.badge}{p.regions.length > 1 ? ` · ${p.regions.length}` : ""}
                        </span>
                    </a>
                ))}
            </div>
            <p style={{ marginTop: ".75rem", fontSize: ".75rem", color: "var(--watch-fg-dim)" }}>
                Data via JustWatch / TMDB. Regions: {Array.from(new Set(all.flatMap((p) => p.regions))).join(", ")}.
            </p>
        </section>
    );
}
