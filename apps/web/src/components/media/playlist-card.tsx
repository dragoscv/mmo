/**
 * Square playlist card with the origin-server badge (WP11-05). Pure server
 * component — links to the playlist page (`/playlists?id=`), which owns
 * playback for the whole list.
 */
import Link from "next/link";
import { ListMusic } from "lucide-react";
import { Badge } from "@mmo/ui";
import type { PlaylistWithSource } from "@/lib/media/listen-types";
import { cn } from "@/lib/utils";

export interface PlaylistCardProps {
    playlist: PlaylistWithSource;
    labels: { tracks: string; offline: string };
    className?: string;
}

export function PlaylistCard({ playlist, labels, className }: PlaylistCardProps) {
    return (
        <div role="listitem" className={cn("w-40 shrink-0 snap-start", className)}>
            <Link
                href={`/playlists?id=${playlist.id}`}
                className="group/card block w-full rounded-xl text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            >
                <div className="relative grid aspect-square w-full place-items-center rounded-xl bg-gradient-to-br from-muted to-muted/50 ring-1 ring-border">
                    <ListMusic aria-hidden className="size-12 text-muted-foreground/40" />
                    <Badge
                        variant={playlist.source.online ? "secondary" : "outline"}
                        className="absolute left-2 top-2 max-w-[calc(100%-1rem)]"
                        title={playlist.source.online ? playlist.source.serverName : `${playlist.source.serverName} · ${labels.offline}`}
                    >
                        <span className="truncate">{playlist.source.serverName}</span>
                    </Badge>
                </div>
                <div className="mt-2 space-y-0.5">
                    <p className="truncate text-sm font-medium leading-tight">{playlist.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{labels.tracks.replace("{count}", String(playlist.trackCount))}</p>
                </div>
            </Link>
        </div>
    );
}
