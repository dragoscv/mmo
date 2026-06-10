"use client";

import { useTransition } from "react";
import { ListPlus, ListVideo } from "lucide-react";
import { usePlayer } from "@/components/player-context";
import { resolveVideoForPlayback } from "@/actions/video-now-playing";
import { toast } from "sonner";

type Mode = "next" | "end";

function Btn({ fileId, mode, label, icon }: { fileId: number; mode: Mode; label: string; icon: React.ReactNode }) {
    const player = usePlayer();
    const [pending, start] = useTransition();
    return (
        <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => {
                const media = await resolveVideoForPlayback(fileId);
                if (!media) { toast.error("Companion offline or file unreachable."); return; }
                if (mode === "next") {
                    player.playVideoNext(media);
                    toast.success("Va fi redat în continuare");
                } else {
                    player.addToVideoQueue(media);
                    toast.success("Added to queue");
                }
            })}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-white/5 hover:bg-white/10 text-zinc-200 border border-white/10 transition-colors disabled:opacity-50 cursor-pointer text-sm"
            title={label}
        >
            {icon}
            <span className="hidden sm:inline">{label}</span>
        </button>
    );
}

export function PlayNextButton({ fileId }: { fileId: number }) {
    return <Btn fileId={fileId} mode="next" label="Play next" icon={<ListPlus className="h-4 w-4" />} />;
}

export function AddToQueueButton({ fileId }: { fileId: number }) {
    return <Btn fileId={fileId} mode="end" label="Add to queue" icon={<ListVideo className="h-4 w-4" />} />;
}
