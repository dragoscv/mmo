"use client";

/**
 * A Media Home tile = the canonical `PosterCard` fed from a merged
 * `TitleCard` (WP11-03). Links to the unified title page; shows the
 * server chips when a title is owned on more than one machine.
 */
import { PosterCard } from "@/components/video/poster-card";
import type { TitleCard } from "@/lib/media/types";

export function titleHref(t: Pick<TitleCard, "kind" | "tmdbId">) {
    return `/media/${t.kind}/${t.tmdbId}`;
}

export function MediaCard({ item, serverLabel }: { item: TitleCard; serverLabel?: string }) {
    const sources = item.sources ?? [];
    const servers = [...new Set(sources.map((s) => s.serverName))];
    const extra = servers.length > 1 ? `${servers.length} ${serverLabel ?? "servers"}` : servers[0] ?? null;
    return (
        <PosterCard
            href={titleHref(item)}
            title={item.title}
            year={item.year ?? null}
            posterPath={item.poster ?? null}
            overview={item.overview ?? null}
            rating={item.rating ?? null}
            progress={item.progress ?? undefined}
            local={item.inLibrary}
            extra={extra}
            preview={{ backdropPath: item.backdrop ?? null }}
            transitionName={`media-${item.kind}-${item.tmdbId}`}
        />
    );
}
