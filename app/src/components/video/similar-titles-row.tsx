import { PosterCard } from "@/components/video/poster-card";
import { buildTmdbHitPosterProps } from "@/lib/poster-card-builder";
import type { TmdbSearchHit } from "@/lib/tmdb";

interface Props {
    title: string;
    items: TmdbSearchHit[];
    /** Map TMDB id -> local DB id so we can deep-link into existing detail pages
     *  when the user already has it; otherwise fall back to a TMDB-only stub. */
    localIndex?: Map<number, number>;
    kind: "movie" | "tv";
    /** Max items shown (default 12). */
    limit?: number;
}

export function SimilarTitlesRow({ title, items, localIndex, kind, limit = 12 }: Props) {
    const filtered = items.filter((i) => i.poster_path).slice(0, limit);
    if (filtered.length === 0) return null;

    return (
        <section style={{ padding: "1.5rem" }}>
            <h2 className="watch-row-title">{title}</h2>
            <div className="watch-row-scroll">
                {filtered.map((it) => (
                    <PosterCard
                        key={`${kind}-${it.id}`}
                        {...buildTmdbHitPosterProps(it, kind, { localId: localIndex?.get(it.id) })}
                    />
                ))}
            </div>
        </section>
    );
}
