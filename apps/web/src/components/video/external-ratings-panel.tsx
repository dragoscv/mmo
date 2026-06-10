"use client";

import { useTransition, useState, useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import type { ExternalRatings } from "@/lib/ratings/scrape";

interface Props {
    initial: ExternalRatings | null;
    fetchedAt: Date | null;
    refreshAction: () => Promise<ExternalRatings>;
}

function hasAnyScore(r: ExternalRatings | null): boolean {
    if (!r) return false;
    return !!(r.imdb?.score || r.rtCritic?.score || r.rtAudience?.score || r.cinemagia?.score);
}

export function ExternalRatingsPanel({ initial, fetchedAt, refreshAction }: Props) {
    const [ratings, setRatings] = useState<ExternalRatings | null>(initial);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const autoTried = useRef(false);

    const stale = !fetchedAt || Date.now() - fetchedAt.getTime() > 7 * 24 * 60 * 60 * 1000;

    const refresh = () => {
        setError(null);
        startTransition(async () => {
            try {
                const r = await refreshAction();
                setRatings(r);
                if (!hasAnyScore(r)) {
                    setError("No ratings found for this title (IMDB id may be missing, or scrapers returned nothing).");
                }
            } catch (e) {
                setError(e instanceof Error ? e.message : "failed");
            }
        });
    };

    // Auto-fetch on mount when we have no ratings yet (and never fetched before).
    useEffect(() => {
        if (autoTried.current) return;
        if (!fetchedAt && !hasAnyScore(initial)) {
            autoTried.current = true;
            refresh();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <section className="external-ratings">
            <header className="external-ratings-head">
                <h2 className="watch-row-title">Ratings</h2>
                <button
                    type="button"
                    className="external-ratings-refresh"
                    onClick={refresh}
                    disabled={pending}
                    title={stale ? "Stale ratings — refresh" : "Refresh"}
                >
                    <RefreshCw size={14} className={pending ? "spin" : ""} />
                    {pending ? "Fetching…" : ratings ? "Refresh" : "Fetch ratings"}
                </button>
            </header>
            {error && <p className="external-ratings-error">{error}</p>}
            <div className="external-ratings-grid">
                <RatingChip label="IMDB" score={ratings?.imdb?.score} max={10} color="#f5c518" href={ratings?.imdb?.url} />
                <RatingChip label="RT" score={ratings?.rtCritic?.score} max={10} raw={ratings?.rtCritic?.raw} color="#fa320a" href={ratings?.rtCritic?.url} />
                <RatingChip label="Audience" score={ratings?.rtAudience?.score} max={10} raw={ratings?.rtAudience?.raw} color="#f97316" href={ratings?.rtAudience?.url} />
                <RatingChip label="CineMagia" score={ratings?.cinemagia?.score} max={10} color="#4ade80" href={ratings?.cinemagia?.url} />
            </div>
            {fetchedAt && (
                <p className="external-ratings-stale">
                    Updated: {fetchedAt.toISOString().slice(0, 10)}{stale ? " · needs refresh" : ""}
                </p>
            )}
        </section>
    );
}

function RatingChip({ label, score, max, raw, color, href }: { label: string; score?: number; max: number; raw?: string; color: string; href?: string }) {
    const display = raw ?? (score != null ? `${score.toFixed(1)} / ${max}` : "—");
    const inner = (
        <div className="rating-chip" style={{ ["--chip-color" as string]: color }}>
            <span className="rating-chip-label">{label}</span>
            <span className="rating-chip-score">{display}</span>
        </div>
    );
    return href && score != null
        ? <a href={href} target="_blank" rel="noopener noreferrer">{inner}</a>
        : inner;
}
