"use client";

import { useTransition } from "react";
import { Film } from "lucide-react";
import { usePlayer } from "@/components/player-context";
import { resolveVideoForPlayback } from "@/actions/video-now-playing";
import { toast } from "sonner";

/** Resolves a `videoFiles.id` via server action and starts playback in the
 *  in-app `<VideoPlayerHost>`. Use alongside the legacy `/watch/play/[id]`
 *  link for users who want the full-page cinema view. */
export function PlayHereButton({ fileId, label = "Play here", className }: {
    fileId: number;
    label?: string;
    className?: string;
}) {
    const player = usePlayer();
    const [pending, start] = useTransition();

    return (
        <button
            type="button"
            disabled={pending}
            onClick={() => {
                start(async () => {
                    const media = await resolveVideoForPlayback(fileId);
                    if (!media) {
                        toast.error("Could not resolve this video for playback. Is the companion online?");
                        return;
                    }
                    player.playVideo(media);
                });
            }}
            className={
                className ??
                "inline-flex items-center gap-2 px-4 py-2 rounded-md bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 border border-purple-500/30 transition-colors disabled:opacity-50 cursor-pointer"
            }
        >
            <Film className="h-4 w-4" />
            {pending ? "Loading…" : label}
        </button>
    );
}
