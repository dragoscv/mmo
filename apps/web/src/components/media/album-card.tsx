"use client";

/**
 * Square album card (WP11-05): 1:1 cover, title, artist · year · N tracks.
 * Click resolves the album's tracks (cloud ids → CompanionTracks) and
 * plays them as a queue. The resolver is injectable so the card is unit
 * testable without a server action.
 */
import { useState, useTransition } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import type { Track } from "@/db/schema";
import { Artwork } from "@/components/artwork";
import { usePlayer } from "@/components/player-context";
import type { CompanionTrack } from "@/lib/companion-library";
import type { Album } from "@/lib/media/listen-types";
import { cn } from "@/lib/utils";
import { getTracksByCloudIds } from "@/actions/track-plays";

export interface AlbumCardProps {
    album: Album;
    labels: { play: string; tracks: string; empty: string };
    /** Resolves cloud track ids → playable tracks. Defaults to the server action. */
    resolveTracks?: (ids: number[]) => Promise<CompanionTrack[]>;
    className?: string;
}

export function AlbumCard({ album, labels, resolveTracks = getTracksByCloudIds, className }: AlbumCardProps) {
    const player = usePlayer();
    const [pending, start] = useTransition();
    const [failed, setFailed] = useState(false);

    function play() {
        setFailed(false);
        start(async () => {
            const list = await resolveTracks(album.trackIds).catch(() => [] as CompanionTrack[]);
            if (list.length === 0) { setFailed(true); toast.error(labels.empty); return; }
            // The resolver returns tracks in `trackIds` order (server preserves it).
            const queue = list as unknown as Track[];
            player.play(queue[0]!, queue);
        });
    }

    const meta = [album.artist, album.year ? String(album.year) : null, labels.tracks.replace("{count}", String(album.trackCount))]
        .filter(Boolean)
        .join(" · ");

    return (
        <div role="listitem" className={cn("w-40 shrink-0 snap-start", className)}>
            <button
                type="button"
                onClick={play}
                disabled={pending}
                aria-busy={pending}
                aria-invalid={failed || undefined}
                aria-label={`${labels.play}: ${album.title}${album.artist ? ` — ${album.artist}` : ""}`}
                className="group/card block w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            >
                <div className="relative">
                    <Artwork src={album.cover} alt="" size="xl" className="!h-auto !w-full aspect-square rounded-xl" />
                    <span
                        aria-hidden
                        className={cn(
                            "absolute inset-0 grid place-items-center rounded-xl bg-background/40 transition-opacity duration-(--dur-fast)",
                            pending ? "opacity-100" : "opacity-0 group-hover/card:opacity-100 group-focus-visible/card:opacity-100",
                        )}
                    >
                        <span className="grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-md">
                            {pending ? <Loader2 className="size-5 animate-spin" /> : <Play className="size-5 translate-x-px" fill="currentColor" />}
                        </span>
                    </span>
                </div>
                <div className="mt-2 space-y-0.5">
                    <p className="truncate text-sm font-medium leading-tight">{album.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{meta}</p>
                </div>
            </button>
        </div>
    );
}
