"use client";

import { useTransition } from "react";
import { Film, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePlayer } from "@/components/player-context";
import { resolveVideoForPlayback, type PlaybackMode } from "@/actions/video-now-playing";

/** Split button: the main face plays in "direct" mode (zero CPU when
 *  a pre-remuxed sidecar exists, falls back to whatever the browser
 *  can play of the source otherwise). The chevron opens a dropdown
 *  letting the user force a different playback pipeline — useful when
 *  direct play stalls (rare codec combo, missing sidecar) or when
 *  they want to force a specific transcode mode for testing. */
export function PlayHereMenu({ fileId }: { fileId: number }) {
    const player = usePlayer();
    const [pending, start] = useTransition();

    const play = (mode: PlaybackMode) => {
        start(async () => {
            const media = await resolveVideoForPlayback(fileId, mode);
            if (!media) {
                toast.error("Could not resolve this video for playback. Is the companion online?");
                return;
            }
            player.playVideo(media);
        });
    };

    return (
        <div className="inline-flex items-stretch rounded-md border border-purple-500/30 bg-purple-500/15 text-purple-200 overflow-hidden">
            <button
                type="button"
                disabled={pending}
                onClick={() => play("direct")}
                className="inline-flex items-center gap-2 px-4 py-2 hover:bg-purple-500/25 transition-colors disabled:opacity-50 cursor-pointer"
            >
                <Film className="h-4 w-4" />
                {pending ? "Loading…" : "Play here"}
            </button>
            <div className="w-px bg-purple-500/30" />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        disabled={pending}
                        aria-label="Playback mode"
                        className="inline-flex items-center px-2 hover:bg-purple-500/25 transition-colors disabled:opacity-50 cursor-pointer"
                    >
                        <ChevronDown className="h-4 w-4" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>Playback mode</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => play("direct")}>
                        <div className="flex flex-col">
                            <span className="font-medium">Direct play (default)</span>
                            <span className="text-xs text-muted-foreground">Stream the file (or its pre-remuxed sidecar) as-is. Zero CPU.</span>
                        </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => play("auto")}>
                        <div className="flex flex-col">
                            <span className="font-medium">Auto</span>
                            <span className="text-xs text-muted-foreground">Companion picks the cheapest path based on your browser.</span>
                        </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => play("remux")}>
                        <div className="flex flex-col">
                            <span className="font-medium">Remux (HLS)</span>
                            <span className="text-xs text-muted-foreground">Repackage to HLS without re-encoding. Low CPU.</span>
                        </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => play("audio-transcode")}>
                        <div className="flex flex-col">
                            <span className="font-medium">Transcode audio only</span>
                            <span className="text-xs text-muted-foreground">Copy video, downmix audio to AAC stereo.</span>
                        </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => play("full-transcode")}>
                        <div className="flex flex-col">
                            <span className="font-medium">Full transcode</span>
                            <span className="text-xs text-muted-foreground">Last resort. Re-encodes video via NVENC. High CPU/GPU.</span>
                        </div>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
