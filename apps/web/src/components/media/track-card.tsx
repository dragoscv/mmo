"use client";

/**
 * Square track card for the Listen rows (WP11-05): 1:1 artwork, title,
 * artist and an optional progress bar ("Continue listening"). Whole card
 * is one button → `play(track, queue)`.
 */
import { Play } from "lucide-react";
import { Artwork } from "@/components/artwork";
import type { CompanionTrack } from "@/lib/companion-library";
import { cn } from "@/lib/utils";
import { PlayTrackButton } from "./play-track-button";

export interface TrackCardProps {
    track: CompanionTrack;
    queue?: CompanionTrack[];
    /** 0..1 — renders a progress bar under the artwork when > 0. */
    progress?: number;
    /** Accessible name prefix, e.g. "Play". */
    playLabel: string;
    className?: string;
}

export function TrackCard({ track, queue, progress = 0, playLabel, className }: TrackCardProps) {
    const title = track.title || track.filename;
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    return (
        <div role="listitem" className={cn("w-40 shrink-0 snap-start", className)}>
            <PlayTrackButton track={track} queue={queue} aria-label={`${playLabel}: ${title}${track.artist ? ` — ${track.artist}` : ""}`}>
                <div className="relative">
                    <Artwork src={track.artworkUrl} alt="" size="xl" className="!h-auto !w-full aspect-square rounded-xl" />
                    <span
                        aria-hidden
                        className={cn(
                            "absolute inset-0 grid place-items-center rounded-xl bg-background/40 opacity-0 transition-opacity duration-(--dur-fast)",
                            "group-hover/card:opacity-100 group-focus-visible/card:opacity-100",
                        )}
                    >
                        <span className="grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-md">
                            <Play className="size-5 translate-x-px" fill="currentColor" />
                        </span>
                    </span>
                    {pct > 0 ? (
                        <span
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={pct}
                            className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-xl bg-muted/70"
                        >
                            <span className="block h-full bg-primary" style={{ width: `${pct}%` }} />
                        </span>
                    ) : null}
                </div>
                <div className="mt-2 space-y-0.5">
                    <p className="truncate text-sm font-medium leading-tight">{title}</p>
                    {track.artist ? <p className="truncate text-xs text-muted-foreground">{track.artist}</p> : null}
                </div>
            </PlayTrackButton>
        </div>
    );
}
